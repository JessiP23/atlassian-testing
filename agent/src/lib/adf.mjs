// Flatten Atlassian Document Format to plain text.
//
// Jira's v3 API returns descriptions and comments as ADF - a nested JSON document - while
// v2 returns wiki-markup strings. The fetcher may end up on either endpoint depending on
// what the site still serves, so it must handle both shapes.

/** @param {any} node ADF node, or a plain string (v2), or null */
export function adfToText(node) {
  if (node == null) return ''
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(adfToText).join(' ')
  if (typeof node !== 'object') return String(node)

  switch (node.type) {
    case 'text':
      return node.text || ''
    case 'hardBreak':
      return '\n'
    case 'codeBlock':
      // Code blocks are noise for topic matching - the identifiers that matter show up
      // in inlineCode and in prose anyway.
      return ' '
    case 'inlineCard':
    case 'blockCard':
      return node.attrs?.url || ''
    case 'mention':
      return node.attrs?.text || ''
    case 'emoji':
      return ''
    case 'mediaSingle':
    case 'media':
      return ''
    default: {
      const inner = node.content ? adfToText(node.content) : ''
      const block = ['paragraph', 'heading', 'listItem', 'blockquote', 'panel', 'tableRow']
      return block.includes(node.type) ? inner + '\n' : inner
    }
  }
}
