import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, statSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CosSync } from '../utils/cosSync.js'

const dir = mkdtempSync(join(tmpdir(), 'iptv-cos-admin-'))
let time = 1_000_000
let calls = []
let fail = false
let release
const configFile = join(dir, 'cos-config.json')
const stateFile = join(dir, 'cos-state.json')
const service = new CosSync({ configFile, stateFile, now: () => time, getPort: () => 12345, sync: async env => {
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
  assert.equal(calls[0].COS_MERGE_LINES, 'true')
  assert.ok(calls[0].COS_SOURCE_URL.startsWith('http://127.0.0.1:12345/'))
  assert.ok(calls[0].COS_SOURCE_URL.endsWith('interface.m3u?profile=bedroom&relay=1'))
  assert.equal(service.view().status.lastSuccessAt, time)
  // 重建服务实例仍然沿用下次执行时间，重启不会额外上传。
  const restarted = new CosSync({ configFile, stateFile, now: () => time, sync: async () => { throw new Error('不应运行') } })
  await restarted.tick()
  fail = true
  time += 120_000
  await assert.rejects(service.tick(), /模拟上传失败/)
  assert.equal(service.view().status.lastError, '模拟上传失败')
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
  await assert.rejects(service.run(), /重复触发/)
  assert.throws(() => service.save({ enabled: true }), /正在上传/)
  release()
  release = undefined
  await pending
  assert.equal(service.view().status.busy, false)
  assert.equal(service.view().status.lastError, '')
  assert.equal(service.view().status.lastSuccessAt, time)
  console.log('COS 后台测试通过：凭据保护、保存校验、定时/关闭/重启/失败重试、手动上传与防重入')
} finally {
  service.stop()
  rmSync(dir, { recursive: true, force: true })
}
