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
pkg.version = pkg.version + '-dev'
pkg.icon = 'icon-dev.png'

// Update default URLs
pkg.contributes.configuration.properties['mobbAiTracer.apiUrl'].default = apiUrl
pkg.contributes.configuration.properties['mobbAiTracer.webAppUrl'].default = webUrl

// Update description to indicate dev version
pkg.description = (pkg.description || '') + ` [DEV BUILD - ${env}]`

// Add graphql as direct dependency (required peer dep for graphql-request and graphql-ws)
pkg.dependencies['graphql'] = '16.9.0'

fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2))

console.log('Modified package.json:')
console.log('  name:', pkg.name)
console.log('  displayName:', pkg.displayName)
console.log('  version:', pkg.version)
