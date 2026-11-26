import type { Command, LocalCommandCall } from '../types/command.js'

const call: LocalCommandCall = async (args, context) => {
  const url = args.trim()
  if (!url || /\s/u.test(url)) {
    return { type: 'text', value: '用法：/address-review <URL>' }
  }
  const { runAddressReview } = await import('../cli/addressReview.js')
  const { signal } = context.abortController
  try {
    const value = await runAddressReview(url, { signal })
    return signal.aborted ? { type: 'skip' } : { type: 'text', value }
  } catch (error) {
    if (signal.aborted) return { type: 'skip' }
    throw error
  }
}

export default {
  type: 'local',
  name: 'address-review',
  argumentHint: '<URL>',
  description: '请当前模型解释 URL 中可见的信息，无需访问该地址',
  isSensitive: true,
  disableModelInvocation: true,
  supportsNonInteractive: false,
  load: async () => ({ call }),
} satisfies Command
