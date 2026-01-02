#!/usr/bin/env node
/**
 * Modifies package.json for dev build.
 * Usage: node modify-package-for-dev.js <api-url> <web-url> <env>
 */
const fs = require('fs')
const path = require('path')

const [, , apiUrl, webUrl, env] = process.argv

if (!apiUrl || !webUrl || !env) {
  console.error('Usage: modify-package-for-dev.js <api-url> <web-url> <env>')
  process.exit(1)
}

const pkgPath = path.join(__dirname, '..', 'package.json')
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))

// Change identity so it can coexist with marketplace version
pkg.name = 'mobb-ai-tracer-dev'
pkg.displayName = 'Mobb AI Tracer (DEV)'
pkg.version = `${pkg.version}-dev`
pkg.icon = 'icon-dev.png'

// Update configuration title and add unique id (so settings are searchable under @ext:)
pkg.contributes.configuration.title = 'Mobb AI Tracer (DEV)'
pkg.contributes.configuration.id = 'mobbAiTracerDev'

// Rename settings keys to be unique for dev extension (avoids conflict with production extension)
// This allows both extensions to coexist with independent settings
const oldProps = pkg.contributes.configuration.properties
pkg.contributes.configuration.properties = {
  'mobbAiTracerDev.apiUrl': {
    ...oldProps['mobbAiTracer.apiUrl'],
    default: apiUrl,
  },
  'mobbAiTracerDev.webAppUrl': {
    ...oldProps['mobbAiTracer.webAppUrl'],
    default: webUrl,
  },
}

console.log('  Setting apiUrl default:', apiUrl)
console.log('  Setting webAppUrl default:', webUrl)

// Update description to indicate dev version
pkg.description = `${pkg.description || ''} [DEV BUILD - ${env}]`

fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2))

console.log('Modified package.json:')
console.log('  name:', pkg.name)
console.log('  displayName:', pkg.displayName)
console.log('  version:', pkg.version)
