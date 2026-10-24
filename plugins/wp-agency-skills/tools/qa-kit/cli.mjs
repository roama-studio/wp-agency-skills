// qa-kit <command>: check (a running site) | code (the project's code) | wp (a WordPress theme)
// | original (an edited client project against its original) | wp-site (a copy of a client's
// WordPress site in Playground: import, start, stop, health, wp, compare) | bridge (the wp-admin
// bridge plugins: export plugin zip, the edit set of an order, dry runs). See README.md.
import { join } from 'node:path'

const [command, ...args] = process.argv.slice(2)

function print(report, file) {
  const s = report.summary
  console.log(`${s.fail} fail, ${s.warn} warn, ${s.info} info${s.failed_checks.length ? ` (failed: ${s.failed_checks.join(', ')})` : ''}`)
  console.log(`report: ${file}`)
}

try {
  if (command === 'check') {
    const { check, checkOptions } = await import('./check.mjs')
    const report = await check(args)
    if (!report.browsers.webkit.available) console.log(`WebKit: ${report.browsers.webkit.reason}`)
    print(report, join(checkOptions(args).out, 'qa-report.json'))
  } else if (command === 'code') {
    const { codeCheck } = await import('./code.mjs')
    const report = codeCheck(args)
    print(report, join(report.out, 'code-report.json'))
  } else if (command === 'wp') {
    const { wpCheck } = await import('./wp.mjs')
    const report = await wpCheck(args)
    console.log(`WordPress ${report.wp}, PHP ${report.php}, ${report.pages.length} pages; server stopped: ${report.server_stopped}`)
    print(report, join(report.out, 'wp-report.json'))
  } else if (command === 'original') {
    const { originalCheck } = await import('./original.mjs')
    const report = await originalCheck(args)
    const changed = report.pairs.filter((p) => p.changed_ratio > 0).length
    console.log(`original ${report.ref.slice(0, 8)} vs the working copy (${report.head.slice(0, 8)}): ${report.pages.length} pages x ${report.widths.length} widths, `
      + `${changed} changed, ${report.added.length} added, ${report.removed.length} removed; servers stopped: ${report.servers_stopped}`)
    print(report, join(report.out, 'original-report.json'))
  } else if (command === 'wp-site') {
    const { wpSite } = await import('./wpsite.mjs')
    const r = await wpSite(args)
    if (r.command === 'import') {
      const s = r.state
      console.log(`imported: WordPress ${s.wp}, theme ${s.theme}, ${s.plugins.length} active plugins, admin "${s.admin}"; `
        + `${s.import.ran}/${s.import.statements} statements ran, ${s.import.failed} failed; `
        + `${s.replacements.reduce((n, x) => n + x.count, 0)} address replacements -> ${s.url}`)
      for (const n of s.notes) console.log(`note: ${n}`)
      console.log(`site.json: ${args[2]}/site.json; next: qa-kit wp-site start ${args[2]}`)
    } else if (r.command === 'start') {
      if (r.state.already) console.log(`already running: ${r.state.url}/`)
    } else if (r.command === 'stop') {
      console.log(`${r.url}: ${r.stopped ? 'stopped' : 'STILL ANSWERS'}`)
      if (!r.stopped) process.exit(1)
    } else if (r.command === 'health') {
      for (const f of r.findings.filter((x) => x.level !== 'info')) console.log(`${f.level}: ${f.check} ${f.page ?? f.file ?? ''} ${f.message}`)
      console.log(`${r.summary.fail} fail, ${r.summary.warn} warn, ${r.summary.info} info; admin: ${r.admin}`)
      if (r.summary.fail) process.exit(1)
    } else if (r.command === 'compare') {
      const rep = r.report
      const changed = rep.pairs.filter((p) => p.changed_ratio > 0).length
      console.log(`original vs edited: ${rep.pages.length} pages x ${rep.widths.length} widths, ${changed} changed, `
        + `${rep.added.length} added, ${rep.removed.length} removed`)
      print(rep, join(rep.out, 'wp-site-compare-report.json'))
    } else {
      process.exit(r.code ?? 0)
    }
  } else if (command === 'bridge') {
    const { bridge } = await import('./bridge.mjs')
    const r = await bridge(args)
    if (r.command === 'export-plugin') console.log(`plugin: ${r.file}`)
    else if (r.command === 'build') {
      console.log(`edit set ${r.manifest.id}: ${r.manifest.edits.length} edits, ${r.unsupported.length} not supported; ${r.out}`)
      for (const u of r.unsupported) console.log(`not supported: ${u}`)
      if (r.newOptions.length) console.log(`new options left out (plugin settings?): ${r.newOptions.join(', ')}; --include-option <name> packs one`)
      console.log(r.zip ? `plugin: ${r.zip}` : 'no plugin zip (nothing to apply, or unsupported changes: see EDITS.md, --allow-unsupported packs the rest)')
      if (r.unsupported.length && !r.zip) process.exit(1)
    } else {
      console.log(JSON.stringify(r.result, null, 1))
      if (!r.result.ok) process.exit(1)
    }
  } else {
    console.log('usage:\n  qa-kit check <code folder> --url http://127.0.0.1:<port>/ [--round N] [--pages /,/a.html,>Tab] [--no-webkit | --webkit] [--country DE]\n  qa-kit code <code folder>\n  qa-kit wp <project folder> --theme <theme folder> [--plugins a,b|none] [--wp-cli "<cmd>"]... [--pages a/,b/] [--php 8.3] [--wp latest] [--port 9400] [--round N] [--no-stress]\n  qa-kit original <code folder> [--ref <git ref, default: the first commit>] [--pages ./,menu.html] [--expect menu.html] [--widths 360,390,768,1440] [--mask ".selector,#id"] [--round N]\n  qa-kit wp-site import <copy folder> <site folder> [--sql db.sql] [--port 9500] | start|stop|health <site> | wp <site> <wp-cli args> | compare <original site> <edited site> [--expect a/] [--widths ...] [--mask ...] [--round N]\n  qa-kit bridge export-plugin [--out dir] | build <original site> <edited site> --order <name> [--note text] [--out dir] [--allow-unsupported] [--no-warm] [--include-option a,b*] | check|apply|rollback <site> <edits.json>')
    process.exit(command ? 2 : 0)
  }
} catch (e) {
  console.error(`qa-kit ${command}: ${e.message}`)
  process.exit(1)
}
