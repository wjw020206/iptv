import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, statSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CosSync, publicServerOrigin } from '../utils/cosSync.js'

const dir = mkdtempSync(join(tmpdir(), 'iptv-cos-admin-'))
let time = 1_000_000
let calls = []
let fail = false
let release
const configFile = join(dir, 'cos-config.json')
const stateFile = join(dir, 'cos-state.json')
const service = new CosSync({ configFile, stateFile, now: () => time, getPort: () => 12345, getProfiles: () => [{ id: 'bedroom' }, { id: 'default' }, { id: 'shaoxing' }, { id: 'guizhou' }], sync: async env => {
  calls.push(env)
  if (release) await new Promise(resolve => { release = resolve })
  if (fail) throw new Error('模拟上传失败')
  return { bytes: 123 }
} })
const config = {
  secretId: 'private-id', secretKey: 'private-key', bucket: 'tv-1234567', region: 'ap-shanghai',
  publicBaseUrl: 'http://203.0.113.10:1905', key: 'tv/iptv.m3u', enabled: true, intervalMinutes: 2,
  profile: 'bedroom', relay: '1',
}
try {
  assert.equal(service.view().config.enabled, false)
  assert.equal(service.view().config.mergeLines, false)
  writeFileSync(configFile, JSON.stringify(config)) // 模拟升级前已保存的单文件配置
  assert.deepEqual(service.config().files, [{ key: config.key, profile: 'bedroom', relay: '1', mergeLines: false }])
  assert.equal(service.config().secretKey, 'private-key')
  assert.equal(service.config().followServerAddress, false, '旧手动地址不能自动改变模式')
  service.save(config)
  assert.equal(statSync(configFile).mode & 0o777, 0o600)
  assert.ok(!JSON.stringify(service.view()).includes('private-'))
  assert.equal(service.view().config.hasSecretKey, true)
  service.save({ secretId: '', secretKey: '' })
  assert.equal(JSON.parse(readFileSync(configFile)).secretKey, 'private-key')
  assert.equal(service.view().url, 'https://tv-1234567.cos.ap-shanghai.myqcloud.com/tv/iptv.m3u')
  for (const input of [{ intervalMinutes: 0 }, { intervalMinutes: 1.5 }, { enabled: 'false' }, { mergeLines: 'true' }, { publicBaseUrl: 'http://localhost:1905' }, { profile: '../bad' }, { relay: '3' }]) {
    assert.throws(() => service.save(input))
  }
  await service.tick()
  assert.equal(calls.length, 0)
  service.save({ mergeLines: true })
  assert.equal(service.view().config.mergeLines, true)
  time += 120_000
  await service.tick()
  assert.equal(calls.length, 1)
  assert.equal(service.state().history[0].trigger, 'scheduled')
  assert.equal(service.state().history[0].status, 'success')
  assert.equal(service.state().history[0].files[0].bytes, 123)
  assert.equal(calls[0].COS_MERGE_LINES, 'true')
  assert.ok(calls[0].COS_SOURCE_URL.startsWith('http://127.0.0.1:12345/'))
  assert.ok(calls[0].COS_SOURCE_URL.endsWith('interface.m3u?profile=bedroom&relay=1&mergeLines=0'))
  assert.equal(service.view().status.lastSuccessAt, time)
  // 重建服务实例仍然沿用下次执行时间，重启不会额外上传。
  const restarted = new CosSync({ configFile, stateFile, now: () => time, sync: async () => { throw new Error('不应运行') } })
  await restarted.tick()
  fail = true
  time += 120_000
  await assert.rejects(service.tick(), /模拟上传失败/)
  assert.match(service.view().status.lastError, /模拟上传失败/)
  const count = calls.length
  await service.tick()
  assert.equal(calls.length, count, '失败后按间隔重试，不得高频重试')
  fail = false
  service.save({ enabled: false })
  time += 999_999
  await service.tick()
  assert.equal(calls.length, count)
  assert.equal(service.view().status.nextRunAt, null)
  // 关闭定时后仍能手动上传；上传期间拒绝保存或重复执行。
  release = true
  const pending = service.run()
  assert.equal(service.view().status.busy, true)
  assert.throws(() => service.clearHistory(), /正在上传/)
  assert.equal(service.state().history[0].status, 'running')
  assert.equal(service.state().history[0].files[0].status, 'running')
  const recoveryFile = join(dir, 'recovered-state.json')
  writeFileSync(recoveryFile, JSON.stringify(service.state()))
  const recovering = new CosSync({ configFile, stateFile: recoveryFile, now: () => time })
  await recovering.tick()
  assert.equal(recovering.state().history[0].status, 'interrupted')
  assert.equal(recovering.state().history[0].files[0].status, 'interrupted')
  assert.equal(recovering.state().history[0].finishedAt, null, '中断任务不能伪造结束时间')
  await assert.rejects(service.run(), /重复触发/)
  assert.throws(() => service.save({ enabled: true }), /正在上传/)
  release()
  release = undefined
  await pending
  assert.equal(service.view().status.busy, false)
  assert.equal(service.view().status.lastError, '')
  assert.equal(service.view().status.lastSuccessAt, time)
  // 老配置自动成为第一份文件；两份独立订阅共用一套上传周期。
  assert.equal(service.view().config.files[0].key, config.key)
  service.save({ files: [
    { key: 'iptv.m3u', profile: 'shaoxing', mergeLines: true },
    { key: 'iptv2.m3u', profile: 'guizhou', relay: '1', mergeLines: false },
  ], enabled: true, intervalMinutes: 3 })
  const before = calls.length
  await service.run()
  assert.equal(calls.length, before + 2)
  assert.equal(calls[before].COS_KEY, 'iptv.m3u')
  assert.match(calls[before].COS_SOURCE_URL, /profile=shaoxing&mergeLines=0$/)
  assert.equal(calls[before].COS_MERGE_LINES, 'true')
  assert.equal(calls[before + 1].COS_KEY, 'iptv2.m3u')
  assert.match(calls[before + 1].COS_SOURCE_URL, /profile=guizhou&relay=1&mergeLines=0$/)
  assert.equal(calls[before + 1].COS_MERGE_LINES, 'false')
  assert.equal(service.view().files.length, 2)
  assert.equal(service.view().files[1].status.lastSuccessAt, time)
  assert.ok(service.view().files[1].url.endsWith('/iptv2.m3u'))
  for (const files of [[], null, [null], [{ key: 'same.m3u' }, { key: 'same.m3u' }], [{ key: '' }], [{ key: 'bad.txt' }], [{ profile: 'missing' }], [{ mergeLines: 'true' }]]) {
    assert.throws(() => service.save({ files }))
  }
  const reload = new CosSync({ configFile, stateFile, now: () => time, sync: async () => { throw new Error('尚未到期') } })
  await reload.tick()
  assert.equal(reload.view().config.files.length, 2)
  time += 180_000
  const scheduled = calls.length
  await service.tick()
  assert.equal(calls.length, scheduled + 2, '一次定时应更新全部文件')
  // 第一份失败也继续上传第二份，并保留各自结果。
  service.sync = async env => {
    calls.push(env)
    if (env.COS_KEY === 'iptv.m3u') throw new Error('第一份失败')
    return { key: env.COS_KEY, bytes: 456 }
  }
  const partial = calls.length
  await assert.rejects(service.run(), /iptv.m3u：第一份失败/)
  assert.equal(calls.length, partial + 2)
  assert.equal(service.view().files[0].status.lastError, '第一份失败')
  assert.equal(service.view().files[1].status.lastError, '')
  assert.equal(service.view().files[1].status.bytes, 456)
  const partialRecord = service.state().history[0]
  assert.equal(partialRecord.status, 'partial')
  assert.equal(partialRecord.trigger, 'manual')
  assert.equal(partialRecord.bucket, config.bucket)
  assert.equal(partialRecord.files[0].status, 'failed')
  assert.equal(partialRecord.files[0].error, '第一份失败')
  assert.equal(partialRecord.files[1].status, 'success')
  assert.equal(partialRecord.files[1].profile, 'guizhou')
  assert.equal(partialRecord.finishedAt, time)
  assert.equal(partialRecord.durationMs, 0)
  service.getProfiles = () => [{ id: 'guizhou' }]
  await assert.rejects(service.run(), /配置档已不存在/)
  assert.equal(service.view().files[1].status.lastError, '')
  service.save({ files: [{ key: 'iptv2.m3u', profile: 'guizhou' }] })
  assert.equal(service.view().files.length, 1)
  assert.equal(service.state().files['iptv.m3u'], undefined)
  assert.ok(service.state().history.some(record => record.files.some(file => file.key === 'iptv.m3u')), '移除文件不删除历史')
  service.sync = async () => { throw new Error('错误包含 private-id private-key') }
  await assert.rejects(service.run(), /已隐藏/)
  assert.equal(service.state().history[0].status, 'failed')
  assert.ok(!JSON.stringify(service.view()).includes('private-'), '状态与历史不得返回密钥')
  service.sync = async env => { time += 1500; return { key: env.COS_KEY, bytes: 789 } }
  const ids = []
  for (let i = 0; i < 102; i++) {
    await service.run()
    ids.push(service.state().history[0].id)
  }
  const history = service.state().history
  assert.equal(history.length, 100)
  assert.deepEqual(history.map(record => record.id), ids.slice(-100).reverse())
  assert.equal(new Set(history.map(record => record.id)).size, 100)
  assert.equal(history[0].durationMs, 1500)
  assert.equal(history[0].files[0].durationMs, 1500)
  const persisted = new CosSync({ configFile, stateFile })
  assert.deepEqual(persisted.view().status.history, history)
  const beforeClear = service.state()
  const configBeforeClear = readFileSync(configFile, 'utf8')
  service.clearHistory()
  assert.deepEqual(service.state(), { ...beforeClear, history: [] })
  assert.equal(readFileSync(configFile, 'utf8'), configBeforeClear)
  assert.equal(new CosSync({ configFile, stateFile }).state().history.length, 0)
  await service.run()
  assert.equal(service.state().history.length, 1, '清空后继续正常记录')
  assert.equal(publicServerOrigin('https://tv.example.com:8443'), 'https://tv.example.com:8443')
  assert.equal(publicServerOrigin('http://47.97.215.97:1905'), 'http://47.97.215.97:1905')
  assert.equal(publicServerOrigin('https://[2001:db8::1]:1905'), 'https://[2001:db8::1]:1905')
  for (const origin of ['http://localhost:1905', 'http://127.0.0.1:1905', 'http://192.168.1.2', 'http://10.0.0.2', 'http://172.16.1.2', 'http://100.64.0.1', 'http://169.254.1.1', 'http://[::1]', 'http://[fd00::1]', 'http://tv.local', 'https://tv.example.com/path', 'https://user:pass@tv.example.com', 'javascript:alert(1)']) {
    assert.equal(publicServerOrigin(origin), '', origin)
  }
  service.save({ followServerAddress: true })
  const beforeFollowState = service.state()
  service.followAddress('https://tv.example.com:8443')
  assert.equal(service.config().publicBaseUrl, 'https://tv.example.com:8443')
  assert.deepEqual(service.state(), beforeFollowState, '跟随地址不重置计划和记录')
  assert.equal(statSync(configFile).mode & 0o777, 0o600)
  service.followAddress('http://localhost:1905')
  assert.equal(service.config().publicBaseUrl, 'https://tv.example.com:8443')
  service.busy = true
  service.followAddress('https://new.example.com')
  assert.equal(service.config().publicBaseUrl, 'https://tv.example.com:8443')
  service.busy = false
  service.save({ followServerAddress: false })
  service.followAddress('https://new.example.com')
  assert.equal(service.config().publicBaseUrl, 'https://tv.example.com:8443')
  assert.throws(() => service.save({ followServerAddress: 'true' }))
  console.log('COS 后台测试通过：多文件、上传历史、手动/定时、部分失败、中断恢复、持久化、100 次上限、凭据保护与防重入')
} finally {
  service.stop()
  rmSync(dir, { recursive: true, force: true })
}
