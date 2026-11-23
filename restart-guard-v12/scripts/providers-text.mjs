import { readFileSync } from 'node:fs'
const text = readFileSync(process.argv[2], 'utf8')
const counts = new Map()
for (const m of text.matchAll(/"provider"\s*:\s*"([^"]+)"/g)) counts.set(m[1], (counts.get(m[1]) ?? 0) + 1)
console.log([...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([n, c]) => `${n}x${c}`).join(', ') || 'none')
