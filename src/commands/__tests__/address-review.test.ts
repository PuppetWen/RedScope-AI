import { expect, spyOn, test } from 'bun:test'
import * as review from '../../cli/addressReview.js'
import type { LocalJSXCommandContext } from '../../types/command.js'
import command from '../address-review.js'

function context(abortController = new AbortController()) {
  return { abortController, options: { mainLoopModel: 'sonnet' } } as LocalJSXCommandContext
}

test('/address-review returns the single shared review response as local text', async () => {
  const invoke = spyOn(review, 'runAddressReview').mockResolvedValue('模型回复\n页面用途需要正文才能确认。')
  try {
    const { call } = await command.load()
    const ctx = context()
    expect(command.type).toBe('local')
    expect((await call('  ', ctx)).type).toBe('text')
    expect((await call('https://example.org/ other text', ctx)).type).toBe('text')
    expect(invoke).not.toHaveBeenCalled()
    expect(await call(' https://example.org/info ', ctx)).toEqual({
      type: 'text', value: '模型回复\n页面用途需要正文才能确认。',
    })
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(invoke).toHaveBeenCalledWith('https://example.org/info', {
      signal: ctx.abortController.signal,
    })
  } finally {
    invoke.mockRestore()
  }
})

test('cancelling an address review suppresses its late output', async () => {
  const controller = new AbortController()
  const invoke = spyOn(review, 'runAddressReview').mockImplementation(async () => {
    controller.abort('user-cancel')
    throw new Error('Cancelled request')
  })
  try {
    const { call } = await command.load()
    expect(await call('https://example.org/info', context(controller))).toEqual({ type: 'skip' })
    expect(invoke).toHaveBeenCalledTimes(1)
  } finally {
    invoke.mockRestore()
  }
})
