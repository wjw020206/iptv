import { pathToFileURL } from 'node:url'
import { syncCos } from '../utils/cosUpload.js'
export { syncCos } from '../utils/cosUpload.js'

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  syncCos().then(({ key, bytes }) => {
    console.log(`COS 同步成功：${key}（${bytes} 字节）`)
  }).catch(error => {
    console.error(`COS 同步失败：${error.message}`)
    process.exitCode = 1
  })
}
