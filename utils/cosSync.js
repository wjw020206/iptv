import { isIP } from 'node:net'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, renameSync, chmodSync } from 'node:fs'
import { dataPath } from './paths.js'
import { writeJsonFileSync } from './fileUtil.js'
import { listProfiles } from './playlistConfig.js'
import { pass, port } from '../config.js'
import { syncCos, validateCosEnv } from './cosUpload.js'

const HISTORY_LIMIT = 100
const FILE_DEFAULTS = { key: 'iptv.m3u', profile: '', relay: '', mergeLines: false }
const DEFAULTS = { secretId: '', secretKey: '', bucket: '', region: 'ap-shanghai', key: 'iptv.m3u', publicBaseUrl: '', followServerAddress: true, profile: '', relay: '', mergeLines: false, enabled: false, intervalMinutes: 10 }

function readJson(file, fallback) {
  if (!existsSync(file)) return fallback
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { throw new Error('COS 配置或状态文件损坏，请检查数据目录') }
}

/** 自动跟随仅接受可供公网访问的地址，避免本地或内网访问覆盖已保存的公网地址。 */
export function publicServerOrigin(value) {
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return ''
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
    if (isIP(host) === 4) {
      const [a, b] = host.split('.').map(Number)
      if (a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)) return ''
    } else if (isIP(host) === 6) {
      // IPv6 公网单播使用 2000::/3；本地、链路本地、组播及 IPv4 映射地址不自动采用。
      if (!/^[23]/.test(host)) return ''
    } else if (!host.includes('.') || /(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(host)) return ''
    return url.origin
  } catch { return '' }
}

/** 后台与定时任务共用一把锁；上传配置和状态保存在持久化数据目录。 */
export class CosSync {
  constructor({ configFile = dataPath('cos-config.json'), stateFile = dataPath('cos-state.json'), sync = syncCos, now = Date.now, getPort = () => port, getProfiles = listProfiles } = {}) {
    Object.assign(this, { configFile, stateFile, sync, now, getPort, getProfiles })
    this.busy = false
    this.timer = null
  }

  config() {
    const saved = readJson(this.configFile, {})
    const c = { ...DEFAULTS, ...saved }
    if (!Object.hasOwn(saved, 'followServerAddress') && saved.publicBaseUrl) c.followServerAddress = false
    const files = c.files || [Object.fromEntries(Object.keys(FILE_DEFAULTS).map(key => [key, c[key]]))]
    return { ...c, ...files[0], files }
  }
  state() { return readJson(this.stateFile, {}) }

  env(c) {
    // COS 的合并选项独立于配置档：先取未合并的清单，再应用当前文件的选项。
    const query = new URLSearchParams()
    if (c.profile) query.set('profile', c.profile)
    if (c.relay) query.set('relay', c.relay)
    query.set('mergeLines', '0')
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
    const files = c.files.map(file => ({ ...file, url: /^[a-zA-Z0-9-]+$/.test(c.bucket) && /^[a-z0-9-]+$/.test(c.region)
      ? `https://${c.bucket}.cos.${c.region}.myqcloud.com/${file.key.split('/').map(encodeURIComponent).join('/')}` : '',
      status: state.files?.[file.key] || {} }))
    return { files, config: { ...safe, hasSecretId: !!secretId, hasSecretKey: !!secretKey }, status: {
      ...state, busy: this.busy, nextRunAt: c.enabled ? (state.nextRunAt || this.now() + c.intervalMinutes * 60_000) : null,
    }, url }
  }

  save(input) {
    if (this.busy) throw new Error('正在上传，请等待完成后再保存配置')
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('COS 配置格式不正确')
    const c = this.config()
    for (const key of Object.keys(DEFAULTS)) {
      if (!Object.hasOwn(input, key)) continue
      if (key === 'enabled' || key === 'mergeLines' || key === 'followServerAddress') {
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
    const fileInputs = Object.hasOwn(input, 'files') ? input.files : [{ ...c.files[0], ...Object.fromEntries(Object.keys(FILE_DEFAULTS).map(key => [key, c[key]])) }, ...c.files.slice(1)]
    if (!Array.isArray(fileInputs) || fileInputs.length < 1 || fileInputs.length > 20) throw new Error('请配置 1–20 份订阅文件')
    const keys = new Set()
    c.files = fileInputs.map(inputFile => {
      if (!inputFile || typeof inputFile !== 'object' || Array.isArray(inputFile)) throw new Error('订阅文件配置格式不正确')
      const file = { ...FILE_DEFAULTS }
      for (const key of Object.keys(FILE_DEFAULTS)) {
        const value = inputFile[key] ?? FILE_DEFAULTS[key]
        if (key === 'mergeLines') {
          if (typeof value !== 'boolean') throw new Error('合并线路开关必须是布尔值')
          file[key] = value
        } else {
          if (typeof value !== 'string' || value.length > 2048) throw new Error('订阅文件配置字段格式不正确')
          file[key] = value.trim()
        }
      }
      if (!file.key || /[\x00-\x1f\x7f]/.test(file.key)) throw new Error('文件路径不能为空或包含控制字符')
      if (keys.has(file.key)) throw new Error('订阅文件路径不能重复，避免互相覆盖')
      keys.add(file.key)
      if (file.profile && !/^[a-z0-9_-]{1,64}$/.test(file.profile)) throw new Error('配置档 ID 格式不正确')
      if (file.profile && !this.getProfiles().some(profile => profile.id === file.profile)) throw new Error(`${file.key}：配置档不存在，请先在我的频道中新建配置档`)
      if (!['', '1', '2'].includes(file.relay)) throw new Error('订阅模式不正确')
      validateCosEnv(this.env({ ...c, ...file }))
      return file
    })
    Object.assign(c, c.files[0]) // 保留旧版接口字段，旧的单文件配置自动作为第一份订阅。
    this.writeConfig(c)
    const state = this.state()
    writeJsonFileSync(this.stateFile, { ...state, files: Object.fromEntries(c.files.map(file => [file.key, state.files?.[file.key] || {}])), nextRunAt: c.enabled ? this.now() + c.intervalMinutes * 60_000 : null })
    return this.view()
  }

  writeConfig(c) {
    // 先建立权限受限的临时文件，再原子替换，避免凭据以默认权限落盘。
    const tmp = `${this.configFile}.tmp`
    if (existsSync(tmp)) chmodSync(tmp, 0o600)
    writeFileSync(tmp, JSON.stringify(c, null, 2), { mode: 0o600 })
    renameSync(tmp, this.configFile)
  }

  followAddress(value) {
    if (this.busy) return this.view()
    const c = this.config()
    const origin = publicServerOrigin(value)
    if (c.followServerAddress && origin && origin !== c.publicBaseUrl) {
      c.publicBaseUrl = origin
      this.writeConfig(c) // 仅更新地址，不重置下一次定时上传时间或历史。
    }
    return this.view()
  }

  clearHistory() {
    if (this.busy) throw new Error('正在上传，请等待完成后再清空记录')
    writeJsonFileSync(this.stateFile, { ...this.state(), history: [] })
    return this.view()
  }

  async run(trigger = 'manual', fileKey) {
    if (this.busy) throw new Error('正在上传，请勿重复触发')
    const c = this.config()
    if (fileKey !== undefined && (typeof fileKey !== 'string' || !fileKey)) throw new Error('请选择要上传的文件')
    const files = fileKey === undefined ? c.files : c.files.filter(file => file.key === fileKey)
    if (!files.length) throw new Error('要上传的文件不存在，请先保存配置')
    const jobs = files.map(file => ({ file, env: this.env({ ...c, ...file }) }))
    const state = { ...this.state(), lastAttemptAt: this.now(), lastError: '', nextRunAt: c.enabled ? this.now() + c.intervalMinutes * 60_000 : null }
    const record = {
      id: randomUUID(), trigger: trigger === 'scheduled' ? 'scheduled' : 'manual',
      startedAt: this.now(), finishedAt: null, durationMs: null, status: 'running',
      bucket: c.bucket, region: c.region,
      files: files.map(file => ({ ...file, status: 'pending' })),
    }
    state.history = [record, ...(state.history || [])].slice(0, HISTORY_LIMIT)
    const errorText = error => {
      let message = String(error?.message || '上传失败')
      for (const secret of [c.secretId, c.secretKey, pass].filter(Boolean)) message = message.split(secret).join('[已隐藏]')
      return message.slice(0, 2048)
    }
    this.busy = true
    try {
      writeJsonFileSync(this.stateFile, state) // 开始时即落盘，重启后可识别未完成的上传。

      const results = []
      const errors = []
      state.files = { ...state.files }
      for (const [index, { file, env }] of jobs.entries()) {
        const fileState = { ...state.files[file.key], lastAttemptAt: this.now(), lastError: '' }
        const item = record.files[index]
        Object.assign(item, { status: 'running', startedAt: this.now() })
        writeJsonFileSync(this.stateFile, state)
        try {
          validateCosEnv(env)
          if (file.profile && !this.getProfiles().some(profile => profile.id === file.profile)) throw new Error('配置档已不存在，请重新选择配置档')
          const result = await this.sync(env)
          Object.assign(fileState, { lastSuccessAt: this.now(), bytes: result.bytes })
          results.push(result)
          Object.assign(item, { status: 'success', bytes: result.bytes })
        } catch (error) {
          fileState.lastError = errorText(error)
          Object.assign(item, { status: 'failed', error: fileState.lastError })
          errors.push(`${file.key}：${fileState.lastError}`)
        }
        item.finishedAt = this.now()
        item.durationMs = Math.max(0, item.finishedAt - item.startedAt)
        state.files[file.key] = fileState
        writeJsonFileSync(this.stateFile, state)
      }
      if (errors.length) throw new Error(errors.join('；'))
      const bytes = results.reduce((sum, result) => sum + result.bytes, 0)
      Object.assign(state, { lastSuccessAt: this.now(), bytes })
      return { files: results, bytes }
    } catch (error) {
      state.lastError = errorText(error)
      throw new Error(state.lastError)
    } finally {
      record.finishedAt = this.now()
      record.durationMs = Math.max(0, record.finishedAt - record.startedAt)
      const successes = record.files.filter(file => file.status === 'success').length
      record.status = successes === record.files.length ? 'success' : successes ? 'partial' : 'failed'
      if (state.lastError) record.error = state.lastError
      this.busy = false
      state.nextRunAt = c.enabled ? this.now() + c.intervalMinutes * 60_000 : null
      writeJsonFileSync(this.stateFile, state)
    }
  }

  async tick() {
    if (this.busy) return
    const c = this.config()
    const state = this.state()
    // 上次进程在上传中退出：结果未知的文件标记为中断，不能误报成功。
    let recovered = false
    for (const record of state.history || []) {
      if (record.status !== 'running') continue
      recovered = true
      record.status = 'interrupted'
      record.error = '服务在上传完成前退出，部分文件的上传结果未知'
      for (const file of record.files) {
        if (file.status === 'pending' || file.status === 'running') {
          file.status = 'interrupted'
          file.error = '服务中断，未确认上传结果'
        }
      }
    }
    if (recovered) {
      state.lastError = '上次上传因服务退出而中断，请查看上传记录'
      writeJsonFileSync(this.stateFile, state)
    }
    if (!c.enabled) return
    if (!state.nextRunAt) {
      writeJsonFileSync(this.stateFile, { ...state, nextRunAt: this.now() + c.intervalMinutes * 60_000 })
    } else if (state.nextRunAt <= this.now()) {
      await this.run('scheduled')
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
