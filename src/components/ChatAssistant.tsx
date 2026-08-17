import { useState, useRef, useEffect } from 'react'
import { generateClient } from 'aws-amplify/data'
import type { Schema } from '../../amplify/data/resource'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import './ChatAssistant.css'

const client = generateClient<Schema>()

// ── Types ─────────────────────────────────────────────────────────────────────

interface Message {
  role: 'user' | 'agent'
  content: string
}

interface ChatAssistantProps {
  viewerRole: 'ACCOUNTANT' | 'CUSTOMER'
  accountantId?: string  // The assigned accountant
  customerId?: string    // The document owner
  documentId?: string    // The specific document being viewed
  onClose?: () => void
}

/**
 * ChatAssistant - Multi-Tenant Financial Compliance AI
 *
 * A React component that provides an AI-powered document analysis interface
 * with multi-tenant isolation for financial compliance workflows.
 *
 * Props:
 * - documentId: The document being analyzed (used for MCP tool filtering)
 * - userId: The customer/user ID (document owner, used for data isolation)
 * - accountantId: The accountant's Cognito SUB (tenant ID for routing & access control)
 * - onClose: Optional callback when assistant is closed
 *
 * Context Injection:
 * All three IDs are passed to the Bedrock Agent for:
 * 1. Multi-tenant isolation at API gateway
 * 2. MCP tool access control and filtering
 * 3. DynamoDB query filtering via GSIs
 *
 * Features:
 * - Streaming SSE responses with thinking block stripping
 * - Suggested prompts for common compliance questions
 * - Browser-native Web Speech API for voice input
 * - Markdown rendering with financial compliance context
 * - Real-time thinking indicator with status feedback
 * - Local session storage for message persistence
 */

// ── Suggested prompts ─────────────────────────────────────────────────────────

const SUGGESTED_PROMPTS = [
  'List all PENDING documents',
  'List all FINALIZED documents',
  'Calculate global tax summary',
  "Find invoices from vendor 'DrugStore'",
] as const

// ── Component ─────────────────────────────────────────────────────────────────

export default function ChatAssistant({ viewerRole, accountantId, customerId, documentId, onClose }: ChatAssistantProps) {
  // ── Create a unique storage key for this session ──
  const storageKey = `chat_history_${viewerRole}_${accountantId ?? 'GLOBAL'}_${customerId ?? 'GLOBAL'}_${documentId ?? 'dashboard_general'}`

  // ── Initialize greeting message ──
  const getGreetingMessage = (): Message => ({
    role: 'agent',
    content: viewerRole === 'ACCOUNTANT'
      ? `👋 Hello! I'm your Financial Compliance Assistant. I can help you analyze client documents, check regulatory compliance, and calculate tax summaries. What would you like to know?`
      : `👋 Hello! I'm your Document Assistant. I can help you understand your documents, check their status, and answer questions about your financial data. What would you like to know?`,
  })

  // ── Load messages from sessionStorage on initialization ──
  const [messages, setMessages] = useState<Message[]>(() => {
    try {
      const saved = sessionStorage.getItem(storageKey)
      if (saved) {
        const parsed = JSON.parse(saved) as Message[]
        // Validate that we have an array of messages with proper structure
        if (Array.isArray(parsed) && parsed.length > 0 && parsed[0].role) {
          return parsed
        }
      }
    } catch (err) {
      console.warn(`Failed to load chat history from sessionStorage: ${err}`)
    }
    // Fallback to greeting message if no saved history
    return [getGreetingMessage()]
  })

  const [input, setInput] = useState('')
  const [thinking, setThinking] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)
  const recognitionRef = useRef<any>(null)
  const [isRecording, setIsRecording] = useState(false)

  // Generate a fresh session ID scoped to this document, user, and accountant
  // Format: doc_session_{accountantId}_{userId}_{documentId}
  const [sessionId] = useState(() => `doc_session_${viewerRole}_${accountantId ?? 'GLOBAL'}_${customerId ?? 'GLOBAL'}_${documentId ?? 'dashboard_general'}`)

  // ── Auto-save messages to sessionStorage whenever they change ──
  useEffect(() => {
    try {
      sessionStorage.setItem(storageKey, JSON.stringify(messages))
    } catch (err) {
      console.error(`Failed to save chat history to sessionStorage: ${err}`)
    }
  }, [messages, storageKey])

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

    try {
      const response = await client.mutations.chatWithAgent({
        prompt: trimmed,
        sessionId,
        accountantId: accountantId || 'GLOBAL',
        customerId: customerId || 'GLOBAL',
        documentId: documentId || 'dashboard_general',
      })

      if (response.errors && response.errors.length > 0) {
        console.error('chatWithAgent errors:', response.errors)
        throw new Error(response.errors[0].message)
      }

      let replyText = response.data ?? ''

      // Safety net: if Lambda still returned raw SSE (during sandbox restarts),
      // extract the text client-side so the user never sees raw data: lines.
      if (replyText.includes('data:') && replyText.includes('"contentBlockDelta"')) {
        let extracted = ''
        for (const line of replyText.split('\n')) {
          const t = line.trim()
          if (!t.startsWith('data:')) continue
          const chunk = t.slice(5).trim()
          if (!chunk || chunk === '[DONE]') continue
          try {
            const p = JSON.parse(chunk)
            extracted += p?.event?.contentBlockDelta?.delta?.text ?? ''
          } catch { /* skip */ }
        }
        replyText = extracted || replyText
      }

      // Strip any residual <thinking> blocks
      replyText = replyText.replace(/<thinking>[\s\S]*?<\/thinking>\s*/g, '').trim()

      setMessages((prev) => [
        ...prev,
        {
          role: 'agent',
          content: replyText || 'Received an empty response from the assistant.',
        },
      ])
    } catch (error) {
      console.error('Agent error:', error)
      setMessages((prev) => [
        ...prev,
        {
          role: 'agent',
          content: '⚠️ Unable to connect to the Financial Compliance Assistant. Please try again.',
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

  // ── Clear chat and sessionStorage ──
  const clearChat = () => {
    setMessages([getGreetingMessage()])
    setInput('')
    try {
      sessionStorage.removeItem(storageKey)
    } catch (err) {
      console.warn(`Failed to clear chat history from sessionStorage: ${err}`)
    }
  }

  // ── Web Speech API Voice Input Handler ──────────────────────────────────────
  const handleVoiceInput = () => {
    // @ts-ignore - Vendor prefixes for SpeechRecognition
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition

    if (!SpeechRecognition) {
      alert('Your browser does not support voice input. Please use Chrome, Edge, or Safari.')
      return
    }

    if (isRecording) {
      // Stop recording
      if (recognitionRef.current) {
        recognitionRef.current.stop()
      }
      return
    }

    // Start recording
    const recognition = new SpeechRecognition()
    recognitionRef.current = recognition

    recognition.lang = 'en-US'
    recognition.interimResults = false
    recognition.maxAlternatives = 1

    recognition.onstart = () => {
      setIsRecording(true)
    }

    recognition.onresult = (event: any) => {
      const transcript = event.results[0][0].transcript
      // Append the voice text to whatever is already in the input box
      setInput((prev) => (prev ? `${prev} ${transcript}` : transcript))
    }

    recognition.onerror = (event: any) => {
      console.error('Speech recognition error:', event.error)
      setIsRecording(false)
      if (event.error === 'no-speech') {
        alert('No speech detected. Please try again.')
      } else if (event.error === 'network') {
        alert('Network error during speech recognition.')
      }
    }

    recognition.onend = () => {
      setIsRecording(false)
    }

    recognition.start()
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
        <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
          <button onClick={clearChat} className="da-clear-btn" type="button">
            Clear
          </button>
          {onClose && (
            <button
              onClick={onClose}
              type="button"
              aria-label="Close chat"
              style={{
                background: "transparent",
                border: "none",
                fontSize: "1.5rem",
                cursor: "pointer",
                color: "#64748b",
                lineHeight: 1,
                padding: "2px 4px",
                display: "flex",
                alignItems: "center",
              }}
            >
              ✕
            </button>
          )}
        </div>
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
              <div className="table-wrapper" style={{ border: "none", boxShadow: "none", borderRadius: 0, background: "transparent" }}>
                <div className="markdown-body">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {msg.content}
                  </ReactMarkdown>
                </div>
              </div>
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
            <span className="da-thinking-text">Consulting documents...</span>
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
          onClick={handleVoiceInput}
          disabled={thinking}
          aria-label={isRecording ? "Stop recording" : "Start voice recording"}
          title={isRecording ? "Stop recording" : "Voice input"}
          style={{
            color: isRecording ? '#ef4444' : '#64748b',
            background: isRecording ? '#fee2e2' : 'transparent',
            animation: isRecording ? 'pulse 1.5s infinite' : 'none',
          }}
        >
          {isRecording ? '🎙️' : '🎤'}
        </button>
      </form>
    </aside>
  )
}
