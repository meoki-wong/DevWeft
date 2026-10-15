#!/usr/bin/env node
/**
 * codemod-async-db.mjs — 方案第 7 节：机械完成「db 调用 await 化 + async 感染 + 事务改造」
 *
 * 两阶段（各单次解析，编辑按位置倒序套用）：
 *  阶段1 事务改造：
 *    - `db.transaction(箭头).immediate()` → `await db.tx(async (tx) => {...})`（体内自由 db→tx）
 *    - `db.transaction(箭头)()`           → 同上
 *    - `const X = db.transaction(箭头)` + `X.immediate()`/`X()` → `const X = (tx) => {...}` + `await db.tx(X)`
 *      （仅当 X 的全部引用是 X.immediate() / X()；否则跳过并告警）
 *  阶段2 await 化（图上 fixpoint，不重解析）：
 *    - `X.prepare(...).get/all/run(...)`、prepared-var 的 `V.get/all/run(...)`、`db.exec(...)` → await
 *    - 含 await 的函数补 async；同文件对 async 函数的直接调用补 await（传递闭包）
 *
 * 排除：EXCLUDE_FNS 中的函数（历史迁移专用，保持同步；postgres 方言下不会被调用）。
 * 用法：node scripts/codemod-async-db.mjs <file...>
 */
import fs from 'node:fs'
import * as acorn from 'acorn'

const DB_IDENTS = new Set(['db', 'database', 'conn'])
const TERMINALS = new Set(['get', 'all', 'run'])
// 历史迁移专用函数：postgres 方言下第一行 return / 基线已含，永远不跑 → 保持同步
const EXCLUDE_FNS = {
  'db/id-sequence.js': new Set(['createIdSequencesTable', 'backfillIdSequence']),
}

function parse(code) {
  return acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'module', allowAwaitOutsideFunction: true })
}

function walk(node, visit, parent = null) {
  if (!node || typeof node.type !== 'string') return
  visit(node, parent)
  for (const key of Object.keys(node)) {
    if (key === 'parent' || key === 'loc' || key === 'range' || key === 'start' || key === 'end') continue
    const v = node[key]
    if (Array.isArray(v)) {
      for (const c of v) {
        if (c && typeof c.type === 'string') {
          c.parent = node
          walk(c, visit, node)
        }
      }
    } else if (v && typeof v.type === 'string') {
      v.parent = node
      walk(v, visit, node)
    }
  }
}

function alreadyAwaited(code, pos) {
  let i = pos - 1
  while (i >= 0 && /\s/.test(code[i])) i--
  return /await$/.test(code.slice(Math.max(0, i - 5), i + 1))
}

function applyEdits(code, edits) {
  edits.sort((a, b) => b.start - a.start || b.end - a.end)
  for (const e of edits) {
    if (e.end < e.start) continue
    code = code.slice(0, e.start) + e.text + code.slice(e.end)
  }
  return code
}

function insideExpectRejects(node) {
  // 调用位于 expect(fn()).rejects 捕获链内 → 插 await 会破坏 rejects 捕获语义；
  // 普通 expect(checkGuard(..)).ok 属性访问不受限（需要 await 才能拿到真实值）
  let n = node.parent
  while (n) {
    if (n.type === 'MemberExpression' && !n.computed && n.property.name === 'rejects') return true
    n = n.parent
  }
  return false
}

function underPromiseCombiner(node) {
  // 调用位于 Promise.all/allSettled/race/any 的参数中 → 并发意图，禁止插入 await
  let n = node.parent
  while (n) {
    if (n.type === 'CallExpression' && n.callee.type === 'MemberExpression' &&
        !n.callee.computed && ['all', 'allSettled', 'race', 'any'].includes(n.callee.property.name) &&
        n.callee.object.type === 'Identifier' && n.callee.object.name === 'Promise') {
      return true
    }
    n = n.parent
  }
  return false
}

function containsAwaitExpr(fn) {
  let has = false
  walk(fn, (n) => { if (n.type === 'AwaitExpression') has = true })
  return has
}

function nearestFn(node) {
  let n = node.parent
  while (n) {
    if (['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(n.type)) return n
    n = n.parent
  }
  return null
}

/* ─────────────── 阶段1：事务改造 ─────────────── */

function phase1(file, code) {
  const ast = parse(code)
  const edits = []
  const warns = []
  const exclude = EXCLUDE_FNS[file] || new Set()

  // 收集「const X = db.transaction(箭头)」及其引用分类
  const txVars = [] // {declNode, varName, arrow, enclosingFn}
  walk(ast, (node) => {
    if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' &&
        node.init && node.init.type === 'CallExpression' &&
        node.init.callee.type === 'MemberExpression' && node.init.callee.property.name === 'transaction' &&
        node.init.callee.object.type === 'Identifier' && DB_IDENTS.has(node.init.callee.object.name)) {
      const arrow = node.init.arguments[0]
      if (arrow && ['ArrowFunctionExpression', 'FunctionExpression'].includes(arrow.type)) {
        txVars.push({ declNode: node, varName: node.id.name, arrow, enclosingFn: nearestFn(node) })
      }
    }
  })

  const txVarByName = new Map(txVars.map((t) => [t.varName, t]))

  walk(ast, (node) => {
    // A4a：db.transaction(箭头).immediate()  A4b：db.transaction(箭头)()
    let txCall = null
    let isImmediate = false
    if (node.type === 'CallExpression' && node.callee) {
      if (node.callee.type === 'MemberExpression' && node.callee.property.name === 'immediate' &&
          node.callee.object.type === 'CallExpression' &&
          node.callee.object.callee.type === 'MemberExpression' &&
          node.callee.object.callee.property.name === 'transaction' &&
          node.callee.object.callee.object.type === 'Identifier' &&
          DB_IDENTS.has(node.callee.object.callee.object.name)) {
        txCall = node.callee.object
        isImmediate = true
      } else if (node.callee.type === 'CallExpression' &&
          node.callee.callee.type === 'MemberExpression' &&
          node.callee.callee.property.name === 'transaction' &&
          node.callee.callee.object.type === 'Identifier' &&
          DB_IDENTS.has(node.callee.callee.object.name)) {
        txCall = node.callee
        isImmediate = false
      }
    }
    if (!txCall) return
    const arrow = txCall.arguments[0]
    if (!arrow || !['ArrowFunctionExpression', 'FunctionExpression'].includes(arrow.type)) return
    const fn = nearestFn(node)
    if (fn && exclude.has(fnName(fn, code))) return

    edits.push({ start: txCall.callee.property.start, end: txCall.callee.property.end, text: 'tx' })
    if (!arrow.async) edits.push({ start: arrow.start, end: arrow.start, text: 'async ' })
    if (!arrow.params.length) {
      const src = code.slice(arrow.start, arrow.end)
      const m = /^\(\s*\)/.exec(src)
      if (m) edits.push({ start: arrow.start, end: arrow.start + m[0].length, text: '(tx)' })
      else edits.push({ start: arrow.start, end: arrow.start, text: '(tx) ' })
    } else {
      edits.push({ start: arrow.params[0].start, end: arrow.params[arrow.params.length - 1].end, text: '(tx)' })
    }
    renameDbIn(arrow.body, edits)
    if (isImmediate) {
      edits.push({ start: node.start, end: node.start, text: alreadyAwaited(code, node.start) ? '' : 'await ' })
      edits.push({ start: txCall.end, end: node.end, text: '' })
    } else {
      // 直接调用：改为 await db.tx(箭头)
      edits.push({ start: node.start, end: node.start, text: alreadyAwaited(code, node.start) ? '' : 'await ' })
      edits.push({ start: txCall.end, end: txCall.end, text: '' })
      edits.push({ start: node.end, end: node.end, text: '' })
      // 结构变化：await db.tx(箭头)——把外层调用的 callee 从「调用结果」变成 db.tx 本身
      // 简化处理：整体替换为 await db.tx(...) 形态由上面三个编辑组合而成：
      //   原: db.transaction(ARROW)()  →  编辑后: await db.tx(ARROW)
      // 其中 node.callee(即 txCall) 的括号保留、外层调用参数列表(应为空)删除
      const args = node.arguments
      if (args.length) {
        warns.push(`direct-call with args at ${node.start} — 需人工处理`)
      }
    }
    // await 落在同步函数里会导致阶段2无法解析：外层函数一并补 async
    if (fn && !fn.async) {
      edits.push({ start: fn.start, end: fn.start, text: 'async ' })
    }
  })

  // A4c：const X = db.transaction(箭头) + X.immediate()/X()
  for (const t of txVars) {
    const fn = t.enclosingFn
    const refs = []
    const scopeRoot = fn || ast
    walk(scopeRoot, (n) => {
      if (n.type === 'Identifier' && n.name === t.varName && n !== t.declNode.id) refs.push(n)
    })
    let ok = refs.length > 0
    const callSites = []
    for (const r of refs) {
      const p = r.parent
      const isImmediateCall = p && p.type === 'MemberExpression' && p.object === r &&
        p.property.name === 'immediate' && p.parent &&
        p.parent.type === 'CallExpression' && p.parent.callee === p
      const isDirectCall = p && p.type === 'CallExpression' && p.callee === r
      if (isImmediateCall) callSites.push({ ref: r, node: p.parent, kind: 'immediate' })
      else if (isDirectCall) {
        if (p.arguments.length) { ok = false; break }
        callSites.push({ ref: r, node: p, kind: 'direct' })
      } else { ok = false; break }
    }
    if (!ok || !callSites.length) {
      if (refs.length) warns.push(`const ${t.varName} = db.transaction(...) 引用形态复杂，跳过（需人工处理）`)
      continue
    }
    if (t.enclosingFn && exclude.has(fnName(t.enclosingFn, code))) continue
    // 声明改写：const X = db.transaction(ARROW) → const X = async (tx) => ARROW'
    // 内部编辑先在箭头文本上局部套用，避免与整体替换的区间重叠
    const inner = []
    if (!t.arrow.async) inner.push({ start: 0, end: 0, text: 'async ' })
    if (!t.arrow.params.length) {
      const src = code.slice(t.arrow.start, t.arrow.end)
      const m = /^\(\s*\)/.exec(src)
      if (m) inner.push({ start: 0, end: m[0].length, text: '(tx)' })
      else inner.push({ start: 0, end: 0, text: '(tx) ' })
    } else {
      inner.push({
        start: t.arrow.params[0].start - t.arrow.start,
        end: t.arrow.params[t.arrow.params.length - 1].end - t.arrow.start,
        text: '(tx)',
      })
    }
    const renameOffsets = []
    walk(t.arrow.body, (n) => {
      if (n.type === 'Identifier' && n.name === 'db') {
        const par = n.parent
        if (par && par.type === 'MemberExpression' && par.property === n && !par.computed) return
        if (par && par.type === 'Property' && par.key === n && !par.computed) return
        renameOffsets.push({ start: n.start - t.arrow.start, end: n.end - t.arrow.start, text: 'tx' })
      }
    })
    const arrowText = applyEdits(code.slice(t.arrow.start, t.arrow.end), [...inner, ...renameOffsets])
    edits.push({
      start: t.declNode.init.start,
      end: t.declNode.init.end,
      text: arrowText,
    })
    // 调用点改写：X.immediate() / X() → await db.tx(X)
    for (const cs of callSites) {
      edits.push({ start: cs.node.start, end: cs.node.start, text: alreadyAwaited(code, cs.node.start) ? '' : 'await ' })
      edits.push({ start: cs.node.callee.start, end: cs.node.end, text: `db.tx(${t.varName})` })
      const csFn = nearestFn(cs.node)
      if (csFn && !csFn.async) edits.push({ start: csFn.start, end: csFn.start, text: 'async ' })
    }
  }

  if (warns.length) console.warn(`[codemod ${file}] WARN:`, warns.join(' | '))
  return applyEdits(code, edits)
}

function fnName(fn, code) {
  if (fn.id) return fn.id.name
  if (fn.parent && fn.parent.type === 'VariableDeclarator' && fn.parent.id.type === 'Identifier') return fn.parent.id.name
  if (fn.parent && fn.parent.type === 'Property' && fn.parent.key) return fn.parent.key.name
  if (fn.parent && fn.parent.type === 'MethodDefinition' && fn.parent.key) return fn.parent.key.name
  return `@${fn.start}`
}

function renameDbIn(body, edits) {
  walk(body, (n) => {
    if (n.type === 'Identifier' && n.name === 'db') {
      const par = n.parent
      if (par && par.type === 'MemberExpression' && par.property === n && !par.computed) return
      if (par && par.type === 'Property' && par.key === n && !par.computed) return
      edits.push({ start: n.start, end: n.end, text: 'tx' })
    }
  })
}

/* ─────────────── 阶段2：await 化 + async 感染 ─────────────── */

function phase2(file, code, externalNames = new Set()) {
  const ast = parse(code)
  const exclude = EXCLUDE_FNS[file] || new Set()

  const awaitSites = [] // {start, end, needsParens}
  const iifeSites = []
  const preparedVars = new Set()
  const fnNodes = [] // {node, name}
  const callEdges = [] // {callerFn, calleeName, start, end, needsParens}

  walk(ast, (node) => {
    if (['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(node.type)) {
      fnNodes.push({ node, name: fnName(node, code) })
    }
    if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' &&
        node.init && node.init.type === 'CallExpression' &&
        node.init.callee.type === 'MemberExpression' && node.init.callee.property.name === 'prepare' &&
        node.init.callee.object.type === 'Identifier' && DB_IDENTS.has(node.init.callee.object.name)) {
      preparedVars.add(node.id.name)
    }
    if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression' && !node.callee.computed) {
      const prop = node.callee.property.name
      const obj = node.callee.object
      let isDbCall = false
      if (TERMINALS.has(prop)) {
        if (obj.type === 'CallExpression' && obj.callee.type === 'MemberExpression' && obj.callee.property.name === 'prepare' &&
            obj.callee.object.type === 'Identifier') {
          isDbCall = true // db.prepare(...).get() 或 tx.prepare(...).get()
        } else if (obj.type === 'Identifier' && preparedVars.has(obj.name)) {
          isDbCall = true
        }
      }
      if (isDbCall) {
        const fn = nearestFn(node)
        if (fn && exclude.has(fnName(fn, code))) return
        if (alreadyAwaited(code, node.start)) return
        if (underPromiseCombiner(node) || insideExpectRejects(node)) return
        const p = node.parent
        const needsParens = p && ((p.type === 'MemberExpression' && p.object === node) ||
          (p.type === 'CallExpression' && p.callee === node))
        awaitSites.push({ start: node.start, end: node.end, needsParens })
      }
      if (prop === 'exec' && obj.type === 'Identifier' && DB_IDENTS.has(obj.name)) {
        const fn = nearestFn(node)
        if (fn && exclude.has(fnName(fn, code))) return
        if (alreadyAwaited(code, node.start)) return
        if (underPromiseCombiner(node) || insideExpectRejects(node)) return
        const p = node.parent
        const needsParens = p && ((p.type === 'MemberExpression' && p.object === node) ||
          (p.type === 'CallExpression' && p.callee === node))
        awaitSites.push({ start: node.start, end: node.end, needsParens })
      }
    }
    // 调用边（同文件）
    if (node.type === 'CallExpression' && node.callee.type === 'Identifier') {
      const fn = nearestFn(node)
      if (fn && exclude.has(fnName(fn, code))) return
      if (underPromiseCombiner(node) || insideExpectRejects(node)) return
      const p = node.parent
      const needsParens = p && ((p.type === 'MemberExpression' && p.object === node) ||
        (p.type === 'CallExpression' && p.callee === node))
      callEdges.push({ callerFn: fn, calleeName: node.callee.name, start: node.start, end: node.end, needsParens, already: alreadyAwaited(code, node.start) })
    }
    // async IIFE：立即执行的箭头/函数表达式调用——fixpoint 后若其已成 async 则补 await
    if (node.type === 'CallExpression' &&
        (node.callee.type === 'ArrowFunctionExpression' || node.callee.type === 'FunctionExpression')) {
      const fn = nearestFn(node)
      if (fn && exclude.has(fnName(fn, code))) return
      if (alreadyAwaited(code, node.start)) return
      if (underPromiseCombiner(node) || insideExpectRejects(node)) return
      const p = node.parent
      const needsParens = p && ((p.type === 'MemberExpression' && p.object === node) ||
        (p.type === 'CallExpression' && p.callee === node))
      iifeSites.push({ arrow: node.callee, callerFn: fn, start: node.start, end: node.end, needsParens, already: false })
    }
  })

  // fixpoint：asyncFns = 直接含 awaitSite 的 fn ∪ 调用 asyncFn 的 fn
  const siteFns = new Set(awaitSites.map((s) => nearestFnByStart(fnNodes, s.start)).filter(Boolean))
  const nameOf = new Map(fnNodes.map((f) => [f.node, f.name]))
  const asyncNames = new Set()
  for (const f of fnNodes) {
    // 原生 async 函数
    if (f.node.async) asyncNames.add(f.name)
  }
  for (const n of externalNames) asyncNames.add(n)
  for (const f of siteFns) asyncNames.add(nameOf.get(f))
  // IIFE：箭头在 fixpoint 后成为 async → 调用点补 await,并把 caller 拉进 async 集合
  for (const site of iifeSites) {
    if (asyncNames.has(nameOf.get(site.arrow))) {
      callEdges.push({ callerFn: site.callerFn, calleeName: null, start: site.start, end: site.end, needsParens: site.needsParens, already: false, force: true })
      if (site.callerFn) {
        const n = nameOf.get(site.callerFn)
        if (!asyncNames.has(n)) asyncNames.add(n)
      }
    }
  }

  let changed = true
  while (changed) {
    changed = false
    for (const e of callEdges) {
      if (e.force && !e.already) {
        if (e.callerFn) {
          const n = nameOf.get(e.callerFn)
          if (!asyncNames.has(n)) { asyncNames.add(n); changed = true }
        }
        continue
      }
      if (asyncNames.has(e.calleeName) && !e.already) {
        if (e.callerFn) {
          const n = nameOf.get(e.callerFn)
          if (!asyncNames.has(n)) {
            asyncNames.add(n)
            changed = true
          }
        }
      }
    }
  }

  const edits = []
  for (const s of awaitSites) {
    edits.push({ start: s.start, end: s.start, text: s.needsParens ? '(await ' : 'await ' })
    if (s.needsParens) edits.push({ start: s.end, end: s.end, text: ')' })
  }
  for (const f of fnNodes) {
    if (!asyncNames.has(f.name) || f.node.async) continue
    if (f.node.type === 'FunctionDeclaration' || f.node.type === 'FunctionExpression' || f.node.type === 'ArrowFunctionExpression') {
      edits.push({ start: f.node.start, end: f.node.start, text: 'async ' })
    }
  }
  for (const e of callEdges) {
    if (e.already) continue
    if (!e.force && !asyncNames.has(e.calleeName)) continue
    edits.push({ start: e.start, end: e.start, text: e.needsParens ? '(await ' : 'await ' })
    if (e.needsParens) edits.push({ start: e.end, end: e.end, text: ')' })
  }

  return applyEdits(code, edits)
}

function nearestFnByStart(fnNodes, pos) {
  // 位置最近的可包裹函数（内层优先）——简化：取包含 pos 且 start 最大者
  let best = null
  for (const f of fnNodes) {
    const s = f.node.start
    const e = f.node.end
    if (s <= pos && pos <= e && (!best || s > best.node.start)) best = f
  }
  return best ? best.node : null
}

/* ─────────────── 主流程 ─────────────── */

const argz = process.argv.slice(2)
let EXTERNAL_NAMES = new Set()
let files = argz
const namesIdx = argz.indexOf('--await-names')
if (namesIdx >= 0) {
  EXTERNAL_NAMES = new Set((argz[namesIdx + 1] || '').split(',').filter(Boolean))
  files = [...argz.slice(0, namesIdx), ...argz.slice(namesIdx + 2)]
}

for (const file of files) {
  const before = fs.readFileSync(file, 'utf8')
  const crlf = before.includes('\r\n')
  const norm = crlf ? before.replace(/\r\n/g, '\n') : before
  try {
    let out = phase1(file, norm)
    out = phase2(file, out, EXTERNAL_NAMES)
    if (crlf) out = out.replace(/\n/g, '\r\n')
    if (out !== before) {
      fs.writeFileSync(file, out)
      console.log(`codemod: ${file}`)
    } else {
      console.log(`unchanged: ${file}`)
    }
  } catch (e) {
    console.error(`FAILED: ${file}: ${e.message}`)
    process.exitCode = 1
  }
}
