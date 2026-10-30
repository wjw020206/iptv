import { existsSync, readFileSync, writeFileSync, renameSync, chmodSync } from 'node:fs'
import { dataPath } from './paths.js'
import { writeJsonFileSync } from './fileUtil.js'
import { pass, port } from '../config.js'
import { syncCos, validateCosEnv } from './cosUpload.js'

const DEFAULTS = { secretId: '', secretKey: '', bucket: '', region: 'ap-shanghai', key: 'iptv.m3u', publicBaseUrl: '', profile: '', relay: '', mergeLines: false, enabled: false, intervalMinutes: 10 }

function readJson(file, fallback) {
  if (!existsSync(file)) return fallback
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { throw new Error('COS 配置或状态文件损坏，请检查数据目录') }
}

/** 后台与定时任务共用一把锁；上传配置和状态保存在持久化数据目录。 */
export class CosSync {
  constructor({ configFile = dataPath('cos-config.json'), stateFile = dataPath('cos-state.json'), sync = syncCos, now = Date.now, getPort = () => port } = {}) {
    Object.assign(this, { configFile, stateFile, sync, now, getPort })
    this.busy = false
    this.timer = null
  }

  config() { return { ...DEFAULTS, ...readJson(this.configFile, {}) } }
  state() { return readJson(this.stateFile, {}) }

  env(c) {
    const query = new URLSearchParams()
    if (c.profile) query.set('profile', c.profile)
    if (c.relay) query.set('relay', c.relay)
    return {
      COS_SECRET_ID: c.secretId, COS_SECRET_KEY: c.secretKey, COS_BUCKET: c.bucket,
      COS_REGION: c.region, COS_KEY: c.key, COS_PUBLIC_BASE_URL: c.publicBaseUrl,
      COS_MERGE_LINES: c.mergeLines ? 'true' : 'false',
      COS_SOURCE_URL: `http://127.0.0.1:${this.getPort()}${pass ? `/${pass}` : ''}/interface.m3u?${query}`,
    }
  }

  view() {
    const c = this.config()
    const { secretId, secretKey, ...safe } = c
    const state = this.state()
    let url = ''
    if (/^[a-zA-Z0-9-]+$/.test(c.bucket) && /^[a-z0-9-]+$/.test(c.region)) {
      url = `https://${c.bucket}.cos.${c.region}.myqcloud.com/${c.key.split('/').map(encodeURIComponent).join('/')}`
    }
    return { config: { ...safe, hasSecretId: !!secretId, hasSecretKey: !!secretKey }, status: {
      ...state, busy: this.busy, nextRunAt: c.enabled ? (state.nextRunAt || this.now() + c.intervalMinutes * 60_000) : null,
    }, url }
  }

  save(input) {
    if (this.busy) throw new Error('正在上传，请等待完成后再保存配置')
    const c = this.config()
    for (const key of Object.keys(DEFAULTS)) {
      if (!Object.hasOwn(input, key)) continue
      if (key === 'enabled' || key === 'mergeLines') {
        if (typeof input[key] !== 'boolean') throw new Error('COS 开关必须是布尔值')
        c[key] = input[key]
      } else if (key === 'intervalMinutes') {
        if (!Number.isInteger(input[key]) || input[key] < 1 || input[key] > 10080) throw new Error('上传间隔应为 1–10080 分钟的整数')
        c[key] = input[key]
      } else {
        if (typeof input[key] !== 'string' || input[key].length > 2048) throw new Error('COS 配置字段格式不正确')
        const value = input[key].trim()
        if ((key === 'secretId' || key === 'secretKey') && !value) continue
        c[key] = value
      }
    }
    if (!/^[a-zA-Z0-9-]+$/.test(c.bucket)) throw new Error('请填写完整 COS 桶名称，例如 my-tv-1250000000')
    if (!/^[a-z0-9-]+$/.test(c.region)) throw new Error('COS 地域格式不正确，例如 ap-shanghai')
    if (c.profile && !/^[a-z0-9_-]{1,64}$/.test(c.profile)) throw new Error('配置档 ID 格式不正确')
    if (!['', '1', '2'].includes(c.relay)) throw new Error('订阅模式不正确')
    validateCosEnv(this.env(c))
    // 先建立权限受限的临时文件，再原子替换，避免凭据以默认权限落盘。
    const tmp = `${this.configFile}.tmp`
    if (existsSync(tmp)) chmodSync(tmp, 0o600)
    writeFileSync(tmp, JSON.stringify(c, null, 2), { mode: 0o600 })
    renameSync(tmp, this.configFile)
    writeJsonFileSync(this.stateFile, { ...this.state(), nextRunAt: c.enabled ? this.now() + c.intervalMinutes * 60_000 : null })
    return this.view()
  }

  async run() {
    if (this.busy) throw new Error('正在上传，请勿重复触发')
    const c = this.config()
    const env = this.env(c)
    validateCosEnv(env)
    const state = { ...this.state(), lastAttemptAt: this.now(), lastError: '', nextRunAt: c.enabled ? this.now() + c.intervalMinutes * 60_000 : null }
    this.busy = true
    try {
      const result = await this.sync(env)
      Object.assign(state, { lastSuccessAt: this.now(), bytes: result.bytes })
      return result
    } catch (error) {
      state.lastError = error.message
      throw error
    } finally {
      this.busy = false
      state.nextRunAt = c.enabled ? this.now() + c.intervalMinutes * 60_000 : null
      writeJsonFileSync(this.stateFile, state)
    }
  }

  async tick() {
    if (this.busy) return
    const c = this.config()
    if (!c.enabled) return
    const state = this.state()
    if (!state.nextRunAt) {
      writeJsonFileSync(this.stateFile, { ...state, nextRunAt: this.now() + c.intervalMinutes * 60_000 })
    } else if (state.nextRunAt <= this.now()) {
      await this.run()
    }
  }

  start() {
    if (this.timer) return
    const tick = () => this.tick().catch(error => console.error(`COS 定时上传失败：${error.message}`))
    void tick()
    this.timer = setInterval(tick, 15_000)
    this.timer.unref()
  }

  stop() { clearInterval(this.timer); this.timer = null }
}

export const cosSync = new CosSync()
