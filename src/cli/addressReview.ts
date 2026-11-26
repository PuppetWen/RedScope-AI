import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { stripVTControlCharacters } from 'node:util'
import { NO_CONTENT_MESSAGE } from '../constants/messages.js'
import { buildAddressReview } from '../utils/addressReview.js'
import { createCombinedAbortSignal } from '../utils/combinedAbortSignal.js'
import { asSystemPrompt } from '../utils/systemPromptType.js'

const maxNotesBytes = 64 * 1024

async function readNotes(path: string): Promise<string> {
  if (!path.trim() || /^[\\/]{2}|^[a-z][a-z\d+.-]*:\/\//i.test(path)) {
    throw new Error('--notes 需要本地 UTF-8 文本文件路径。')
  }
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK).catch(() => {
    throw new Error('无法打开 --notes 指定的本地文件。')
  })
  try {
    const info = await file.stat()
    if (!info.isFile()) throw new Error('--notes 需要普通文本文件。')
    const tooLarge = '--notes 文件超过 64 KiB，请选择较短的摘录。'
    if (info.size > maxNotesBytes) throw new Error(tooLarge)
    // The file can grow after stat. Read one extra byte to detect overflow.
    const buffer = Buffer.alloc(maxNotesBytes + 1)
    let length = 0
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null)
      if (bytesRead === 0) break
      length += bytesRead
    }
    if (length > maxNotesBytes) throw new Error(tooLarge)
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length))
    } catch {
      throw new Error('--notes 文件需要使用 UTF-8 编码。')
    }
  } finally {
    await file.close()
  }
}

type ReviewReply = { text: string; issue?: string }

async function requestReview(
  review: ReturnType<typeof buildAddressReview>,
  override: string | undefined,
  signal: AbortSignal,
): Promise<ReviewReply> {
  const { getAPIProvider } = await import('../utils/model/providers.js')
  const { getMainLoopModel, getUserSpecifiedModelSetting, parseUserSpecifiedModel } =
    await import('../utils/model/model.js')
  const provider = getAPIProvider()
  const explicitModel = override ? parseUserSpecifiedModel(override) : undefined
  signal.throwIfAborted()
  // These protocols have their own clients and credentials. Use the same model
  // mappings as the interactive adapters, unless the caller selected a model.
  if (provider === 'openai' || provider === 'grok' || provider === 'gemini') {
    const { resolveOpenAIModel, resolveGrokModel, resolveGeminiModel } = await import('@ant/model-provider')
    const resolveModel = { openai: resolveOpenAIModel, grok: resolveGrokModel, gemini: resolveGeminiModel }[provider]
    const model = explicitModel ?? resolveModel(parseUserSpecifiedModel(getUserSpecifiedModelSetting() || 'sonnet'))
    const pieces: string[] = []
    const refusalText: string[] = []
    let refused = false
    if (provider === 'gemini') {
      const { streamGeminiGenerateContent } = await import('../services/api/gemini/client.js')
      const stream = streamGeminiGenerateContent({
        model, signal,
        body: {
          systemInstruction: { parts: [{ text: review.systemPrompt }] },
          contents: [{ role: 'user', parts: [{ text: review.userPrompt }] }],
        },
      })
      for await (const chunk of stream) {
        const candidate = chunk.candidates?.[0]
        for (const part of candidate?.content?.parts ?? []) {
          if (part.text && !part.thought) pieces.push(part.text)
        }
        if (candidate?.finishReason && ['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII'].includes(candidate.finishReason)) {
          refused = true
        }
        if ('promptFeedback' in chunk && chunk.promptFeedback && typeof chunk.promptFeedback === 'object' && 'blockReason' in chunk.promptFeedback) {
          refused = true
        }
      }
    } else {
      const client = provider === 'openai'
        ? (await import('../services/api/openai/client.js')).getOpenAIClient()
        : (await import('../services/api/grok/client.js')).getGrokClient()
      const stream = await client.chat.completions.create({
        model, stream: true,
        messages: [{ role: 'system', content: review.systemPrompt }, { role: 'user', content: review.userPrompt }],
      }, { signal, maxRetries: 0 })
      for await (const chunk of stream) {
        const choice = chunk.choices[0]
        if (choice?.delta.content) pieces.push(choice.delta.content)
        if (choice?.delta.refusal) refusalText.push(choice.delta.refusal)
        if (choice?.delta.refusal || choice?.finish_reason === 'content_filter') refused = true
      }
    }
    return refused ? { text: refusalText.join(''), issue: '模型拒绝了本次请求' } : { text: pieces.join('') }
  }

  const { queryWithModel } = await import('../services/api/claude.js')
  const { extractTextContent } = await import('../utils/messages.js')
  const result = await queryWithModel({
    systemPrompt: asSystemPrompt([review.systemPrompt]),
    userPrompt: review.userPrompt,
    signal,
    options: {
      model: explicitModel ?? getMainLoopModel(),
      querySource: 'address_review',
      agents: [],
      mcpTools: [],
      isNonInteractiveSession: true,
      hasAppendSystemPrompt: false,
      maxOutputTokensOverride: 1200,
    },
  })
  if (result.isApiErrorMessage) {
    // Synthetic error text can contain private request data.
    return { text: '', issue: result.error === 'invalid_request' ? '模型服务未接受本次请求' : '模型请求未完成' }
  }
  return {
    text: extractTextContent(result.message.content, '\n'),
    issue: result.message.stop_reason === 'refusal' ? '模型拒绝了本次请求' : undefined,
  }
}

export async function runAddressReview(
  url: string,
  options: { notes?: string; model?: string; signal?: AbortSignal } = {},
): Promise<string> {
  options.signal?.throwIfAborted()
  const notes = options.notes === undefined ? undefined : await readNotes(options.notes)
  const review = buildAddressReview(url, notes)
  const local = (reason: string) => `本地基础说明（${reason}）\n${review.fallback}`
  if (options.model !== undefined && !options.model.trim()) {
    throw new Error('--model 需要非空的模型名称。')
  }

  const { signal, cleanup } = createCombinedAbortSignal(options.signal, { timeoutMs: 45_000 })
  const interrupted = new Promise<never>((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
  try {
    signal.throwIfAborted()
    const result = await Promise.race([requestReview(review, options.model, signal), interrupted])
    signal.throwIfAborted()
    const reply = stripVTControlCharacters(result.text).trim()
    if (result.issue) return reply ? `模型拒绝回复\n${reply}\n\n${local(result.issue)}` : local(result.issue)
    return reply && reply !== NO_CONTENT_MESSAGE ? `模型回复\n${reply}` : local('模型未返回文本')
  } catch {
    options.signal?.throwIfAborted()
    return local(signal.aborted ? '模型请求超时' : '模型请求未完成')
  } finally {
    cleanup()
  }
}
