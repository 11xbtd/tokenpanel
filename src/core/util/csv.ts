export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  const input = text.replace(/^\uFEFF/, '')

  const pushField = () => {
    row.push(field)
    field = ''
  }
  const pushRow = () => {
    pushField()
    if (row.some((cell) => cell.trim() !== '')) rows.push(row)
    row = []
  }

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]
    if (quoted) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"'
          i++
        } else {
          quoted = false
        }
      } else {
        field += ch
      }
      continue
    }
    if (ch === '"') {
      quoted = true
    } else if (ch === ',') {
      pushField()
    } else if (ch === '\n') {
      pushRow()
    } else if (ch === '\r') {
      if (input[i + 1] === '\n') i++
      pushRow()
    } else {
      field += ch
    }
  }
  if (field !== '' || row.length > 0) pushRow()
  return rows
}

export function toCsv(rows: Array<Array<string | number | undefined | null>>): string {
  const escape = (value: string | number | undefined | null) => {
    const text = value === undefined || value === null ? '' : String(value)
    if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`
    return text
  }
  return `\uFEFF${rows.map((row) => row.map(escape).join(',')).join('\r\n')}`
}
