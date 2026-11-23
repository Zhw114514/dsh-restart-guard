import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
const path = process.argv[2]
const text = zstdDecompressSync(readFileSync(path)).toString('utf8')
const counts = new Map()
for (const m of text.matchAll(/"provider"\s*:\s*"([^"]+)"/g)) counts.set(m[1], (counts.get(m[1]) ?? 0) + 1)
const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4)
console.log(top.map(([name, n]) => `${name}x${n}`).join(', ') || 'none')
