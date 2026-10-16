import { ExtensionError } from '../../extensions/contracts.js'

/** A deterministic, offline DesignSource example for local tests and contributors. */
export const exampleDesignSource = Object.freeze({
  id: 'example-fixture',
  async listTools() {
    return [{ name: 'example_get_design', description: 'Return the checked-in public design fixture.' }]
  },
  async callTool(_username, tool, args = {}) {
    if (tool !== 'example_get_design') throw new ExtensionError('EXTENSION_REJECTED', `Unsupported fixture tool: ${tool}`)
    const content = `Public design fixture${args.page ? ` for ${String(args.page).slice(0, 80)}` : ''}.`
    return {
      content,
      isError: false,
      truncated: false,
      chars: content.length,
    }
  },
})
