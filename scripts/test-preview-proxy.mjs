import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'iptv-preview-'))
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
const seen = []
const ua = 'okHttp/Mod-1.5.0.0'
const upstream = http.createServer((req, res) => {
  seen.push({ path: req.url, ua: req.headers['user-agent'], referer: req.headers.referer, origin: req.headers.origin })
  if (![ua, 'Other/1'].includes(req.headers['user-agent'])) { res.writeHead(403); res.end(); return }
  if (req.url === '/master.m3u8') {
    res.writeHead(302, { Location: '/redirected/master.m3u8' }); res.end()
  } else if (req.url === '/redirected/master.m3u8') {
    res.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100000\n../media.m3u8\n')
  } else if (req.url === '/media.m3u8') {
    res.end('#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-KEY:METHOD=AES-128,URI="/secret.key"\n#EXT-X-MAP:URI="/init.mp4"\n#EXTINF:6,\n/segment.ts\n')
  } else if (req.url === '/broken.m3u8') {
    res.writeHead(403); res.end('denied')
  } else {
    res.end(req.headers['user-agent'] + ':media')
  }
})
const upstreamPort = await listen(upstream)
const reserve = http.createServer()
const port = await listen(reserve)
await new Promise(resolve => reserve.close(resolve))
Object.assign(process.env, { mdataDir: dir, mport: String(port), mpass: 'preview-test-pass', mblank: 'true', mbuiltInSourcesUrl: '', NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' })
const source = { id: 'previewfixture', name: '预览测试源', mode: 'subscription', enabled: true, previewProxy: true, userAgent: ua, playWithUserAgent: false, autoUpdate: false, updateOnStartup: false,
  parsedChannels: [{ name: 'UA测试台', group: '预览', url: `http://127.0.0.1:${upstreamPort}/master.m3u8`, opts: ['http-referrer=https://source.example/', 'http-origin=https://source.example'] }] }
writeFileSync(join(dir, 'external-sources.json'), JSON.stringify({ enabled: true, updateOnStartup: false, sources: [source] }))
writeFileSync(join(dir, 'interface.txt'), `#EXTM3U\n#EXTINF:-1 group-title="预览" source-ids="ext:${source.id}",UA测试台\n#EXTVLCOPT:http-referrer=https://source.example/\n#EXTVLCOPT:http-origin=https://source.example\n${source.parsedChannels[0].url}\n`)
writeFileSync(join(dir, 'interfaceTXT.txt'), '')
let exitCode = 0
let browser
try {
  const { previewPath } = await import('../utils/previewProxy.js')
  const { externalSourceManager } = await import('../utils/channelMerger.js')
  await import('../app.js')
  const base = `http://127.0.0.1:${port}`
  const api = base + '/preview-test-pass'
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + '/favicon.ico')).ok) break } catch {}
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.equal((await fetch(base + '/api/preview', { method: 'POST', body: '{}' })).status, 403)
  const playlist = await (await fetch(api + '/api/my-playlist')).json()
  const channel = playlist.data.flatMap(group => group.channels).find(ch => ch.name === 'UA测试台')
  assert.equal(channel.previewProxy, true)
  const before = await (await fetch(api + '/interface.m3u')).text()
  assert.doesNotMatch(before, /\/api\/preview\//)
  assert.doesNotMatch(before, /http-user-agent=/, 'preview UA must not enable subscription UA')
  const create = async id => fetch(api + '/api/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ channelId: id, url: 'http://ignored.invalid/' }) })
  assert.equal((await create('missing')).status, 400)
  const result = await (await create(channel.id)).json()
  assert.equal(result.success, true)
  assert.match(result.path, /^s[0-9a-f]{16}\.m3u8$/)
  const prefix = api + '/api/preview/'
  assert.equal((await fetch(base + '/api/preview/' + result.path)).status, 403)
  const master = await (await fetch(prefix + result.path)).text()
  assert.doesNotMatch(master, /127\.0\.0\.1|https?:\/\//)
  const mediaPath = master.split('\n').find(line => line && !line.startsWith('#'))
  const media = await (await fetch(prefix + mediaPath)).text()
  assert.doesNotMatch(media, /https?:\/\//)
  const targets = [...media.matchAll(/URI="([^"]+)"/g)].map(m => m[1])
  targets.push(media.split('\n').find(line => line && !line.startsWith('#')))
  assert.equal(targets.length, 3)
  for (const path of targets) assert.equal(await (await fetch(prefix + path)).text(), ua + ':media')
  assert.ok(seen.some(item => item.path === '/redirected/master.m3u8'))
  assert.ok(seen.every(item => item.ua === ua && item.referer === 'https://source.example/' && item.origin === 'https://source.example'))
  const otherPath = previewPath({ ...channel, opts: ['http-user-agent=Other/1'] }, [source])
  assert.notEqual(otherPath, result.path, 'different request headers must be isolated')
  await fetch(prefix + otherPath)
  await fetch(prefix + result.path)
  assert.equal(seen.at(-1).ua, ua)
  const broken = previewPath({ ...channel, url: `http://127.0.0.1:${upstreamPort}/broken.m3u8` }, [source])
  assert.equal((await fetch(prefix + broken, { redirect: 'manual' })).status, 502, 'must not redirect back without UA')
  if (process.argv.includes("--ui")) {
    // Exercise the real admin page, including the source setting and play button.
    const { default: puppeteer } = await import('puppeteer')
    const { findSystemChrome } = await import('../utils/browserLauncher.js')
    browser = await puppeteer.launch({ headless: true, executablePath: findSystemChrome() || undefined })
    const page = await browser.newPage()
    const pageErrors = []
    page.on('pageerror', error => pageErrors.push(error.message))
    await page.goto(api + '/admin', { waitUntil: 'networkidle0' })
    await page.evaluate(async () => { await loadMyPlaylist() })
    const previewResponse = page.waitForResponse(response => response.url().endsWith('/api/preview') && response.request().method() === 'POST')
    await page.evaluate(id => playInlineById(id), channel.id)
    assert.equal((await previewResponse).status(), 200)
    await page.waitForFunction(() => document.getElementById('inlinePlayer').dataset.url.includes('/api/preview/s'))
    assert.equal(await page.evaluate(() => document.getElementById('inlinePlayer').open), true)
    await page.evaluate(() => closeInlinePlayer())
    assert.deepEqual(pageErrors, [])
  }
  externalSourceManager.sources.sources[0].previewProxy = false
  assert.equal((await create(channel.id)).status, 400)
  assert.equal(await (await fetch(api + '/interface.m3u')).text(), before, 'preview toggle must leave subscriptions unchanged')
  console.log('网页预览代理联调通过：鉴权、独立开关、真实 UA、重定向、嵌套清单、密钥、初始化分片、视频分片、请求头隔离、订阅不变')
} catch (error) {
  console.error(error)
  exitCode = 1
} finally {
  if (browser) await browser.close()
  upstream.closeAllConnections()
  upstream.close()
  rmSync(dir, { recursive: true, force: true })
  process.exit(exitCode)
}
