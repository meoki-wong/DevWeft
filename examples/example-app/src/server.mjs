import { createServer } from 'node:http'
import { greeting, normalizeName } from './app.mjs'

export function createExampleServer() {
  return createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    if (url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ status: 'ok' }))
      return
    }
    if (url.pathname === '/api/greeting') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ message: greeting(normalizeName(url.searchParams.get('name'))) }))
      return
    }
    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ error: 'not_found' }))
  })
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT || 3000)
  const server = createExampleServer()
  server.listen(port, '127.0.0.1', () => {
    process.stdout.write(`example-app listening on http://127.0.0.1:${port}\n`)
  })
}
