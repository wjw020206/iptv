/** 真实后台页面与 API 联调；只模拟 COS 写入，不访问腾讯云。需本机安装 Chrome。 */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import http from 'node:http'
import puppeteer from 'puppeteer'

const dir = mkdtempSync(join(tmpdir(), 'iptv-cos-ui-'))
const probe = http.createServer()
await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve))
const port = probe.address().port
await new Promise(resolve => probe.close(resolve))
Object.assign(process.env, { mdataDir: dir, mport: String(port), mpass: 'cos-test-pass', mblank: 'true', mbuiltInSourcesUrl: '', NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' })
writeFileSync(join(dir, 'external-sources.json'), JSON.stringify({ enabled: false, updateOnStartup: false, sources: [] }))
writeFileSync(join(dir, 'interface.txt'), '#EXTM3U x-tvg-url="${replace}/playback.xml"\n#EXTINF:-1 tvg-name="测试" group-title="测试",测试\n${replace}/123\n#EXTINF:-1 tvg-name="测试" group-title="备用",测试\n${replace}/relay/ysp-test.m3u8\n')
writeFileSync(join(dir, 'interfaceTXT.txt'), '测试,#genre#\n测试,${replace}/123\n')
let browser
let exitCode = 0
try {
  const { cosSync } = await import('../utils/cosSync.js')
  const { syncCos } = await import('../utils/cosUpload.js')
  const uploads = []
  cosSync.sync = env => syncCos(env, { upload: async params => { uploads.push(params) } })
  const { createProfile, saveConfig } = await import('../utils/playlistConfig.js')
  assert.equal(createProfile({ id: 'guizhou', name: '贵州' }).success, true)
  assert.equal(saveConfig('guizhou', { deletedGroups: ['备用'] }).success, true)
  await import('../app.js')
  const origin = `http://127.0.0.1:${port}`
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${origin}/favicon.ico`)).ok) break } catch { /* 等待监听 */ }
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.equal((await fetch(`${origin}/api/cos`)).status, 403)
  assert.equal((await fetch(`${origin}/api/cos`, { method: 'POST', body: JSON.stringify({ action: 'upload' }) })).status, 403)
  assert.equal((await fetch(`${origin}/api/cos`, { method: 'POST', body: JSON.stringify({ action: 'clearHistory' }) })).status, 403)
  const { findSystemChrome } = await import('../utils/browserLauncher.js')
  browser = await puppeteer.launch({ headless: true, executablePath: findSystemChrome() || undefined })
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(`${origin}/cos-test-pass/admin`, { waitUntil: 'networkidle0' })
  await page.evaluate(async () => { await switchTab(2); switchSettingsTab(7) })
  await page.waitForFunction(() => document.querySelector('#cosSecretId').placeholder === '填写 SecretId')
  assert.equal(await page.$eval('#cosFollowServerAddress', el => el.checked), true)
  assert.ok((await page.$eval('#cosAddressHint', el => el.textContent)).includes('本地或内网'))
  await page.$eval('#cosFollowServerAddress', el => el.click())
  const values = { cosSecretId: 'test-id', cosSecretKey: 'test-key', cosBucket: 'tv-12345', cosRegion: 'ap-shanghai', cosKey: 'tv.m3u', cosPublicBaseUrl: 'http://203.0.113.10:1905', cosIntervalMinutes: '2' }
  for (const [id, value] of Object.entries(values)) {
    await page.$eval(`#${id}`, (el, value) => { el.value = value }, value)
  }
  await page.click('#cosUploadBtn')
  await page.waitForFunction(() => !document.querySelector('#cosFields').disabled && document.querySelector('#cosStatus').textContent.includes('最近上传成功'))
  assert.equal(uploads.length, 1)
  assert.ok(uploads[0].Body.toString().includes('http://203.0.113.10:1905/cos-test-pass/'))
  assert.ok(!uploads[0].Body.toString().includes('127.0.0.1'))
  assert.equal(await page.$eval('#cosSecretKey', el => el.value), '')
  assert.equal(await page.$eval('#cosUrl', el => el.value), 'https://tv-12345.cos.ap-shanghai.myqcloud.com/tv.m3u')
  assert.equal((uploads[0].Body.toString().match(/^#EXTINF:/gm) || []).length, 2)
  await page.$eval('#cosMergeLines', el => el.click())
  assert.equal(await page.$eval('#cosMergeLines', el => el.checked), true)
  await page.click('#cosUploadBtn')
  await page.waitForFunction(() => !document.querySelector('#cosFields').disabled && document.querySelector('#cosStatus').textContent.includes('最近上传成功'))
  assert.equal(uploads.length, 2)
  assert.equal(cosSync.view().config.mergeLines, true)
  assert.equal((uploads[1].Body.toString().match(/^#EXTINF:/gm) || []).length, 1, uploads[1].Body.toString())
  assert.ok(uploads[1].Body.toString().includes('/123\nhttp://203.0.113.10:1905/cos-test-pass/relay/ysp-test.m3u8'))
  // 同一批次按不同配置档渲染成两份实际不同内容，切换文件不丢未保存的编辑。
  await page.evaluate(() => addCosFile())
  assert.equal(await page.$eval('#cosKey', el => el.value), 'iptv2.m3u')
  await page.select('#cosProfile', 'guizhou')
  await page.select('#cosFileSelect', '0')
  assert.equal(await page.$eval('#cosKey', el => el.value), 'tv.m3u')
  assert.equal(await page.$eval('#cosMergeLines', el => el.checked), true)
  await page.select('#cosFileSelect', '1')
  assert.equal(await page.$eval('#cosProfile', el => el.value), 'guizhou')
  await page.click('#cosUploadBtn')
  await page.waitForFunction(() => !document.querySelector('#cosFields').disabled && document.querySelector('#cosStatus').textContent.includes('已保存文件数：2'))
  assert.equal(uploads.length, 4)
  assert.equal(uploads[2].Key, 'tv.m3u')
  assert.equal(uploads[3].Key, 'iptv2.m3u')
  assert.notEqual(uploads[2].Body.toString(), uploads[3].Body.toString())
  assert.ok(uploads[2].Body.toString().includes('/relay/ysp-test.m3u8'))
  assert.ok(!uploads[3].Body.toString().includes('/relay/ysp-test.m3u8'))
  assert.ok(uploads[3].Body.toString().includes('/123'))
  assert.ok(uploads[3].ContentDisposition.includes('iptv2.m3u'))
  assert.ok((await page.$eval('#cosUrl', el => el.value)).endsWith('/iptv2.m3u'))
  await page.evaluate(() => addCosFile())
  assert.equal(await page.$eval('#cosKey', el => el.value), 'iptv3.m3u')
  await page.evaluate(() => removeCosFile())
  assert.equal(await page.$$eval('#cosFileSelect option', els => els.length), 2)
  await page.$eval('#cosEnabled', el => el.click())
  await page.click('#cosSaveBtn')
  await page.waitForFunction(() => !document.querySelector('#cosFields').disabled && !document.querySelector('#cosStatus').textContent.includes('未开启'))
  assert.equal(cosSync.view().config.enabled, true)
  await page.reload({ waitUntil: 'networkidle0' })
  await page.evaluate(async () => { await switchTab(2); switchSettingsTab(7) })
  await page.waitForFunction(() => document.querySelector('#cosEnabled').checked)
  assert.equal(await page.$eval('#cosSecretKey', el => el.value), '')
  const data = await (await fetch(`${origin}/cos-test-pass/api/cos`)).json()
  assert.ok(!JSON.stringify(data).includes('test-key'))
  assert.ok(!JSON.stringify(data).includes('test-id'))
  assert.equal(data.config.hasSecretKey, true)
  assert.equal(data.config.files.length, 2)
  assert.equal(data.config.files[1].profile, 'guizhou')
  assert.equal(data.config.mergeLines, true)
  assert.equal(await page.$eval('#cosMergeLines', el => el.checked), true)
  // 实际上传历史：多文件详情、按文件筛选、部分失败及分页。
  assert.equal(data.status.history.length, 3)
  assert.equal(await page.$$eval('#cosHistoryList details', els => els.length), 3)
  await page.$eval('#cosHistoryList details', el => { el.open = true })
  assert.ok((await page.$eval('#cosHistoryList details', el => el.textContent)).includes('iptv2.m3u'))
  await page.select('#cosHistoryFilter', 'iptv2.m3u')
  assert.equal(await page.$$eval('#cosHistoryList details', els => els.length), 1)
  assert.ok((await page.$eval('#cosHistoryList', el => el.textContent)).includes('配置档：guizhou'))
  const originalSync = cosSync.sync
  cosSync.sync = async env => {
    if (env.COS_KEY === 'tv.m3u') throw new Error('测试失败 <img src=x onerror=alert(1)>')
    return originalSync(env)
  }
  await assert.rejects(cosSync.run(), /测试失败/)
  await page.evaluate(() => loadCosConfig())
  assert.ok((await page.$eval('#cosHistoryList details summary', el => el.textContent)).includes('部分成功'))
  await page.select('#cosHistoryFilter', '')
  await page.$eval('#cosHistoryList details', el => { el.open = true })
  assert.ok((await page.$eval('#cosHistoryList details', el => el.textContent)).includes('测试失败 <img'))
  assert.equal(await page.$$eval('#cosHistoryList img', els => els.length), 0, '错误信息必须作为纯文本显示')
  cosSync.sync = originalSync
  for (let i = 0; i < 9; i++) await cosSync.run()
  await page.evaluate(() => loadCosConfig())
  assert.equal(await page.$$eval('#cosHistoryList details', els => els.length), 10)
  assert.equal(await page.$eval('#cosHistoryNext', el => el.disabled), false)
  await page.$eval('#cosHistoryNext', el => el.click())
  assert.equal(await page.$$eval('#cosHistoryList details', els => els.length), 3)
  assert.equal(await page.$eval('#cosHistoryNext', el => el.disabled), true)
  await page.$eval('#cosHistoryPrev', el => el.click())
  assert.equal(await page.$$eval('#cosHistoryList details', els => els.length), 10)
  await page.$eval('#cosHistoryList details', el => { el.open = true })
  // 沿用原有输入框样式，密码输入框与普通文本框尺寸/边框一致。
  assert.deepEqual(await page.evaluate(() => {
    const style = id => { const s = getComputedStyle(document.getElementById(id)); return [s.height, s.padding, s.borderRadius, s.borderColor] }
    return style('cosSecretKey')
  }), await page.evaluate(() => { const s = getComputedStyle(document.getElementById('cosBucket')); return [s.height, s.padding, s.borderRadius, s.borderColor] }))
  await page.screenshot({ path: '/tmp/iptv-cos-admin-desktop.png', fullPage: true })
  await page.setViewport({ width: 390, height: 844 })
  await page.screenshot({ path: '/tmp/iptv-cos-admin-mobile.png', fullPage: true })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, '窄屏不应横向溢出')
  // 清空须确认，取消保留历史，确认后仅历史清空。
  const stateBeforeClear = cosSync.state()
  const configBeforeClear = cosSync.config()
  await page.$eval('#cosHistoryClear', el => el.click())
  await page.waitForSelector('#confirmOverlay[open]')
  await page.click('#confirmOverlay .confirm-btn-cancel')
  assert.equal(cosSync.state().history.length, 13)
  await page.$eval('#cosHistoryClear', el => el.click())
  await page.waitForSelector('#confirmOverlay[open]')
  await page.click('#confirmOverlay .confirm-btn-confirm')
  await page.waitForFunction(() => document.querySelector('#cosHistoryList').textContent === '暂无上传记录' && !document.querySelector('#cosFields').disabled)
  assert.equal(await page.$eval('#cosHistoryClear', el => el.disabled), true)
  assert.deepEqual(cosSync.state(), { ...stateBeforeClear, history: [] })
  assert.deepEqual(cosSync.config(), configBeforeClear)
  cosSync.save({ followServerAddress: true })
  const followResult = await (await fetch(`${origin}/cos-test-pass/api/cos`, { method: 'POST', body: JSON.stringify({ action: 'followAddress', publicBaseUrl: 'https://tv.example.com:8443' }) })).json()
  assert.equal(followResult.config.publicBaseUrl, 'https://tv.example.com:8443')
  await page.reload({ waitUntil: 'networkidle0' })
  await page.evaluate(async () => { await switchTab(2); switchSettingsTab(7) })
  await page.waitForFunction(() => document.querySelector('#cosFollowServerAddress').checked)
  assert.equal(await page.$eval('#cosPublicBaseUrl', el => el.value), 'https://tv.example.com:8443', '本地访问不能覆盖已保存的公网地址')
  assert.deepEqual(errors, [])
  console.log('COS 页面/API 联调通过：多文件不同内容、上传历史详情/筛选/分页/错误文本、鉴权、凭据保护、刷新恢复、移动布局')
} catch (error) {
  console.error(error)
  exitCode = 1
} finally {
  if (browser) await browser.close()
  rmSync(dir, { recursive: true, force: true })
  process.exit(exitCode)
}
