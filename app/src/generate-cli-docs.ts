// Generate CLI reference documentation pages from the Zig CLI source.
// Parses cli/zig/src/main.zig to extract zeke command definitions, mirrors
// them as goke commands, then uses goke's generateDocs() to produce markdown.
// Each page gets holocron-compatible YAML frontmatter with title, description,
// and icon.
//
// Run: pnpm generate:cli-docs

import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import goke, { generateDocs } from 'goke'

const __dirname = dirname(fileURLToPath(import.meta.url))
const zigSource = readFileSync(resolve(__dirname, '../../cli/zig/src/main.zig'), 'utf-8')
const cliPkg = JSON.parse(readFileSync(resolve(__dirname, '../../cli/package.json'), 'utf-8'))
const outDir = resolve(__dirname, 'docs/cli')

// ── Parse Zig source ──

interface ZigCommand {
  varName: string
  name: string
  description: string
  options: { raw: string; description: string }[]
  examples: string[]
}

function parseZigCommands(source: string): { commands: ZigCommand[]; globalOptions: { raw: string; description: string }[] } {
  const commands: ZigCommand[] = []
  const globalOptions: { raw: string; description: string }[] = []

  // Parse global options from: const Global = zeke.globalOpts().option(...)
  const globalBlock = source.match(/const\s+Global\s*=\s*zeke\.globalOpts\(\)([\s\S]*?);/)?.[1] ?? ''
  for (const m of globalBlock.matchAll(/\.option\("([^"]+)",\s*"([^"]+)"\)/g)) {
    globalOptions.push({ raw: m[1], description: m[2] })
  }

  // Parse each command block: const <Name> = zeke.cmd("<cmd>", "<desc>")...;
  const cmdRegex = /const\s+(\w+)\s*=\s*zeke\.cmd\("([^"]+)",\s*"([^"]+)"\)([\s\S]*?);/g
  for (const m of source.matchAll(cmdRegex)) {
    const varName = m[1]
    const name = m[2]
    const description = m[3]
    const tail = m[4]

    const options: { raw: string; description: string }[] = []
    for (const opt of tail.matchAll(/\.option\("([^"]+)",\s*"([^"]+)"\)/g)) {
      options.push({ raw: opt[1], description: opt[2] })
    }

    const examples: string[] = []
    for (const ex of tail.matchAll(/\.example\("([^"]+)"\)/g)) {
      examples.push(ex[1])
    }

    commands.push({ varName, name, description, options, examples })
  }

  return { commands, globalOptions }
}

// ── Build goke CLI mirror ──

const { commands, globalOptions } = parseZigCommands(zigSource)

const cli = goke('sigillo').version(cliPkg.version).help()

// Register global options
for (const opt of globalOptions) {
  cli.option(opt.raw, opt.description)
}

// Register each command
for (const cmd of commands) {
  let c = cli.command(cmd.name, cmd.description)
  for (const opt of cmd.options) {
    c = c.option(opt.raw, opt.description)
  }
  for (const ex of cmd.examples) {
    c = c.example(ex)
  }
}

// ── Generate docs ──

const pages = generateDocs({ cli })

// ── Icon mapping for command groups ──

const iconMap: Record<string, string> = {
  index: 'lucide:terminal',
  login: 'lucide:log-in',
  logout: 'lucide:log-out',
  me: 'lucide:user',
  setup: 'lucide:settings',
  run: 'lucide:play',
  secrets: 'lucide:lock',
  'secrets-get': 'lucide:key',
  'secrets-set': 'lucide:pencil',
  'secrets-delete': 'lucide:trash-2',
  'secrets-download': 'lucide:download',
  orgs: 'lucide:building-2',
  'orgs-create': 'lucide:plus',
  projects: 'lucide:folder',
  'projects-create': 'lucide:folder-plus',
  'projects-get': 'lucide:folder-search',
  'projects-update': 'lucide:folder-pen',
  'projects-delete': 'lucide:folder-x',
  environments: 'lucide:layers',
  'environments-create': 'lucide:plus',
  'environments-get': 'lucide:search',
  'environments-rename': 'lucide:pencil',
  'environments-delete': 'lucide:trash-2',
}

// ── Write .mdx files ──

// Clean existing generated files
mkdirSync(outDir, { recursive: true })
for (const file of readdirSync(outDir)) {
  if (file.endsWith('.mdx')) {
    rmSync(join(outDir, file))
  }
}

for (const page of pages) {
  const isIndex = page.slug === 'index'
  const icon = iconMap[page.slug] ?? 'lucide:terminal'

  const title = isIndex ? 'CLI Reference' : page.command
  const description = isIndex
    ? 'All sigillo CLI commands and options'
    : commands.find((c) => c.name === page.command)?.description ?? `sigillo ${page.command} command reference`

  const frontmatter = [
    '---',
    `$schema: https://holocron.so/frontmatter.json`,
    `title: "${title.replace(/"/g, '\\"')}"`,
    `description: "${description.replace(/"/g, '\\"')}"`,
    `icon: ${icon}`,
    '---',
  ].join('\n')

  // Strip the first heading from content since holocron uses the frontmatter title
  let contentWithoutTitle = page.content.replace(/^#\s+.+\n\n?/, '')

  // goke outputs links as ./slug.md but holocron resolves by slug path without
  // extension. Rewrite internal .md links to extensionless relative paths.
  contentWithoutTitle = contentWithoutTitle.replace(/\(\.\/([^)]+)\.md\)/g, '(./$1)')

  const mdx = `${frontmatter}\n\n${contentWithoutTitle}`
  const filePath = join(outDir, `${page.slug}.mdx`)
  writeFileSync(filePath, mdx)
  console.log(`wrote ${filePath}`)
}

console.log(`\nGenerated ${pages.length} CLI docs pages in ${outDir}`)
