import { useState, useRef, useEffect } from 'react'
import { fetchAuthSession } from 'aws-amplify/auth'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import './ChatAssistant.css'

// ── Types ─────────────────────────────────────────────────────────────────────

interface Message {
  role: 'user' | 'agent'
  content: string
}

interface ChatAssistantProps {
  documentId: string
  userId: string
  accountantId: string
  onClose?: () => void
}

// ── Suggested prompts ─────────────────────────────────────────────────────────

const SUGGESTED_PROMPTS = [
  'What are the tax implications of this expense?',
  'Is this document compliant with our policies?',
  'Summarize the key financial details',
  'Flag any potential compliance issues',
] as const

// ── Environment config ────────────────────────────────────────────────────────

const GATEWAY_URL = import.meta.env.VITE_BEDROCK_AGENT_GATEWAY_URL || '/api/bedrock/invoke'
const IS_LOCAL = !import.meta.env.VITE_BEDROCK_AGENT_GATEWAY_URL

// ── Auth helper ───────────────────────────────────────────────────────────────

async function getCognitoToken(): Promise<string | null> {
  if (IS_LOCAL) return null
  try {
    const session = await fetchAuthSession()
    return session.tokens?.accessToken?.toString() ?? null
  } catch {
    return null
  }
}

// ── SSE / JSON response parser ────────────────────────────────────────────────

function parseAgentResponse(rawText: string): string {
  try {
    // 1. Unwrap the Lambda proxy wrapper
    const outer = JSON.parse(rawText)

    if (outer.statusCode && outer.statusCode >= 400) {
      return `⚠️ API Error: ${outer.body}`
    }

    const bodyContent = outer.body ?? rawText

    // 2. Parse SSE Stream
    if (typeof bodyContent === 'string' && bodyContent.includes('data:')) {
      let text = ''
      for (const line of bodyContent.split('\n')) {
        const trimmedLine = line.trim()
        if (!trimmedLine.startsWith('data:')) continue

        const chunk = trimmedLine.slice(5).trim()
        if (!chunk || chunk === '[DONE]') continue

        try {
          const parsedChunk = JSON.parse(chunk)
          text += parsedChunk?.event?.contentBlockDelta?.delta?.text ?? ''
        } catch {
          // Skip unparseable chunks
        }
      }
      if (text) {
        // Strip out the internal <thinking> block
        return text.replace(/<thinking>[\s\S]*?<\/thinking>\s*/g, '').trim()
      }
    }

    // 3. Parse Flat JSON
    const candidate = typeof bodyContent === 'string' ? JSON.parse(bodyContent) : bodyContent
    if (candidate?.error || candidate?.errorMessage) {
      return `⚠️ Agent error: ${candidate.error ?? candidate.errorMessage}`
    }
    return (
      candidate?.message ??
      candidate?.response ??
      candidate?.result ??
      candidate?.content ??
      rawText
    )
  } catch {
    return rawText
  }
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function ChatAssistant({ documentId, userId, accountantId }: ChatAssistantProps) {
  const [messages, setMessages] = useState<Message[]>([
    {
      role: 'agent',
      content: `👋 Hello! I'm the AI Document Assistant. I can help you analyze this document, answer questions about its contents, and identify potential issues or opportunities. What would you like to know?`,
    },
  ])
  const [input, setInput] = useState('')
  const [thinking, setThinking] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const audioChunksRef = useRef<Blob[]>([])
  const [isRecording, setIsRecording] = useState(false)
  const [isBrowserSupported, setIsBrowserSupported] = useState(true)

  // Generate a fresh session ID scoped to this document, user, and accountant
  // Format: doc_session_{accountantId}_{userId}_{documentId}
  const [sessionId] = useState(() => `doc_session_${accountantId}_${userId}_${documentId}`)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, thinking])

  // ── Send message ──────────────────────────────────────────────────────────
  const sendMessage = async (userPrompt: string) => {
    const trimmed = userPrompt.trim()
    if (!trimmed || thinking) return

    setMessages((prev) => [...prev, { role: 'user', content: trimmed }])
    setInput('')
    setThinking(true)

    // Enrich prompt with full multi-tenant context
    const enrichedPrompt = `${trimmed}\n\n[CONTEXT: Accountant ${accountantId} is analyzing document ${documentId} for customer ${userId}. Use available tools to fetch relevant data before responding. Focus on financial compliance and tax implications.]`

    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }

      if (IS_LOCAL) {
        headers['X-Local-Mode'] = 'true'
      } else {
        const token = await getCognitoToken()
        if (token) headers['Authorization'] = `Bearer ${token}`
      }

      const response = await fetch(GATEWAY_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          prompt: enrichedPrompt,
          sessionId,
          documentId,
          userId,
          accountantId,
          actor: accountantId,
        }),
      })

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${await response.text()}`)
      }

      const replyText = parseAgentResponse(await response.text())

      setMessages((prev) => [
        ...prev,
        {
          role: 'agent',
          content: replyText.trim() || 'Received an empty response from the assistant.',
        },
      ])
    } catch (error) {
      console.error('Agent error:', error)
      setMessages((prev) => [
        ...prev,
        {
          role: 'agent',
          content: IS_LOCAL
            ? '⚠️ Unable to reach Bedrock Agent. Make sure your agent gateway is running.'
            : '⚠️ Unable to connect to the Document Assistant. Please try again.',
        },
      ])
    } finally {
      setThinking(false)
    }
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    void sendMessage(input)
  }

  const clearChat = () => {
    setMessages([
      {
        role: 'agent',
        content: `👋 Hello! I'm the AI Document Assistant. I can help you analyze this document, answer questions about its contents, and identify potential issues or opportunities. What would you like to know?`,
      },
    ])
    setInput('')
  }

  // ── Voice input handler ──────────────────────────────────────────────────────
  const toggleVoiceRecording = async () => {
    if (isRecording) {
      // Stop recording
      if (mediaRecorderRef.current) {
        mediaRecorderRef.current.stop()
        setIsRecording(false)
      }
    } else {
      // Start recording
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
        const mediaRecorder = new MediaRecorder(stream)
        mediaRecorderRef.current = mediaRecorder
        audioChunksRef.current = []

        mediaRecorder.ondataavailable = (event: BlobEvent) => {
          audioChunksRef.current.push(event.data)
        }

        mediaRecorder.onstop = async () => {
          const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/wav' })
          // For now, send a placeholder transcription
          // In production, integrate with AWS Transcribe or similar
          const transcribedText = `[Voice message: ${audioBlob.size} bytes recorded]`
          void sendMessage(transcribedText)
          stream.getTracks().forEach(track => track.stop())
        }

        mediaRecorder.start()
        setIsRecording(true)
      } catch (err) {
        console.error('Microphone access denied:', err)
        setIsBrowserSupported(false)
      }
    }
  }

  return (
    <aside className="da-panel" aria-label="Document Assistant chat">
      {/* ── Header ── */}
      <div className="da-header">
        <div className="da-header-left">
          <span className="da-icon" aria-hidden="true">🤖</span>
          <div>
            <p className="da-title">Document Assistant</p>
            <p className="da-subtitle">Powered by Bedrock AI</p>
          </div>
        </div>
        <button onClick={clearChat} className="da-clear-btn" type="button">
          Clear
        </button>
      </div>

      {/* ── Message list ── */}
      <div className="da-message-list" role="log" aria-live="polite" aria-label="Chat messages">
        {messages.map((msg, i) => (
          <div
            key={i}
            className={`da-bubble ${msg.role === 'user' ? 'da-bubble--user' : 'da-bubble--agent'}`}
            style={msg.role === 'user' ? { whiteSpace: 'pre-wrap' } : {}}
          >
            {msg.role === 'agent' ? (
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {msg.content}
              </ReactMarkdown>
            ) : (
              msg.content
            )}
          </div>
        ))}

        {thinking && (
          <div className="da-bubble da-bubble--agent da-bubble--thinking">
            <span className="da-dot" />
            <span className="da-dot" />
            <span className="da-dot" />
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* ── Suggested prompts ── */}
      {messages.length <= 1 && !thinking && (
        <div className="da-prompt-row" role="list" aria-label="Suggested questions">
          {SUGGESTED_PROMPTS.map((p) => (
            <button
              key={p}
              role="listitem"
              className="da-prompt-pill"
              type="button"
              onClick={() => void sendMessage(p)}
            >
              {p}
            </button>
          ))}
        </div>
      )}

      {/* ── Input: Keyboard + Voice ── */}
      <form onSubmit={handleSubmit} className="da-input-row" aria-label="Send a message">
        <input
          className="da-input"
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Type or use voice..."
          disabled={thinking || isRecording}
          aria-label="Message input"
        />
        <button
          className="da-send-btn"
          type="submit"
          disabled={!input.trim() || thinking}
          aria-label="Send message"
        >
          ↑
        </button>
        <button
          className="da-voice-btn-small"
          type="button"
          onClick={toggleVoiceRecording}
          disabled={thinking}
          aria-label={isRecording ? "Stop recording" : "Start voice recording"}
          title={isRecording ? "Stop recording" : "Voice input"}
        >
          {isRecording ? '🎙️' : '🎤'}
        </button>
      </form>
    </aside>
  )
}
