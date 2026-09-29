import { useEffect, useRef, useState } from 'react'
import type { FormEvent, KeyboardEvent } from 'react'
import {
  BookOpenCheck,
  BrainCircuit,
  Check,
  ChevronDown,
  CircleHelp,
  Clock3,
  FileText,
  Frown,
  GraduationCap,
  Eye,
  EyeOff,
  LogOut,
  Menu,
  MessageSquareText,
  Mic,
  MicOff,
  Paperclip,
  PanelLeftOpen,
  Plus,
  Settings,
  Send,
  Sparkles,
  X,
} from 'lucide-react'
import type { User } from '@supabase/supabase-js'
import { detectLocale, locales, messages as translations } from './lib/i18n'
import type { AppLocale } from './lib/i18n'
import {
  readAccentTheme,
  readCookieConsent,
  readGuestName,
  removeGuestName,
  savePreferences,
  writeCookie,
} from './lib/preferences'
import type { AccentTheme, CookieConsent } from './lib/preferences'
import { supabase } from './lib/supabase'

const CHAT_STORAGE_KEY = 'daleel-local-chats'
const DAILY_LIMIT = 40
const GUEST_CHAT_TTL_MS = 24 * 60 * 60 * 1000

type Message = {
  id: string
  role: 'user' | 'assistant'
  content: string
  created_at: string
  attachments?: MessageAttachment[]
  is_out_of_scope?: boolean
}

type MessageAttachment = {
  name: string
  path: string
  type: string
  size: number
}

type Conversation = {
  id: string
  title: string
  updated_at: string
  guest_expires_at?: string | null
}

type LocalConversation = Conversation & { messages: Message[] }
type AuthMode = 'signin' | 'signup'
type SpeechResultEvent = Event & { results: ArrayLike<ArrayLike<{ transcript: string }>> }
type SpeechRecognitionLike = {
  lang: string
  interimResults: boolean
  onresult: ((event: SpeechResultEvent) => void) | null
  onerror: (() => void) | null
  onend: (() => void) | null
  start: () => void
  stop: () => void
}
type SpeechRecognitionWindow = Window & {
  SpeechRecognition?: new () => SpeechRecognitionLike
  webkitSpeechRecognition?: new () => SpeechRecognitionLike
}

const ATTACHMENT_BUCKET = 'academic-attachments'
const MAX_FILE_SIZE = 10 * 1024 * 1024
const MAX_ATTACHMENTS = 5
const MAX_MESSAGE_LENGTH = 8000
const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf',
  'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain', 'text/csv',
])

const suggestionIcons = [GraduationCap, BookOpenCheck, Clock3, CircleHelp]

function readLocalChats(): LocalConversation[] {
  try {
    const saved = localStorage.getItem(CHAT_STORAGE_KEY)
    if (!saved) return []
    const conversations = JSON.parse(saved) as LocalConversation[]
    const recent = conversations.filter((conversation) => Date.now() - Date.parse(conversation.updated_at) < GUEST_CHAT_TTL_MS)
    if (recent.length !== conversations.length) localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(recent))
    return recent
  } catch {
    return []
  }
}

function getTodayKey() {
  const dateParts = new Intl.DateTimeFormat('en', {
    timeZone: 'Asia/Hebron',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date())
  const date = Object.fromEntries(dateParts.map(({ type, value }) => [type, value]))
  return `daleel-daily-${date.year}-${date.month}-${date.day}`
}

function getLocalUsage() {
  return Number(localStorage.getItem(getTodayKey()) || 0)
}

function getUserName(user: User | null, localName: string, locale: AppLocale) {
  const fallback = locale === 'ar' ? 'طالب جامعة الخليل' : locale === 'he' ? 'סטודנט מאוניברסיטת חברון' : 'Hebron University student'
  const savedName = (user?.user_metadata?.full_name as string | undefined) || localName
  return savedName?.trim() || fallback
}

function playUiSound(kind: 'send' | 'voice') {
  try {
    const audio = new AudioContext()
    const oscillator = audio.createOscillator()
    const gain = audio.createGain()
    const now = audio.currentTime
    oscillator.type = 'sine'
    oscillator.frequency.setValueAtTime(kind === 'send' ? 660 : 520, now)
    gain.gain.setValueAtTime(0.045, now)
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.13)
    oscillator.connect(gain)
    gain.connect(audio.destination)
    oscillator.start(now)
    oscillator.stop(now + 0.13)
    oscillator.onended = () => { void audio.close() }
  } catch {
    // Audio is optional; sending and recording must work without it.
  }
}

function App() {
  const [authUser, setAuthUser] = useState<User | null>(null)
  const [authReady, setAuthReady] = useState(() => !supabase)
  const [guestAuthFailed, setGuestAuthFailed] = useState(false)
  const [locale, setLocale] = useState<AppLocale>(() => detectLocale())
  const [theme, setTheme] = useState<AccentTheme>(() => readAccentTheme())
  const [cookieConsent, setCookieConsent] = useState<CookieConsent>(() => readCookieConsent())
  const [cookieNameDraft, setCookieNameDraft] = useState(() => readGuestName())
  const [localName, setLocalName] = useState(() => readGuestName())
  const [conversations, setConversations] = useState<Conversation[]>(() => readLocalChats())
  const [activeId, setActiveId] = useState<string | null>(() => readLocalChats()[0]?.id ?? null)
  const [messages, setMessages] = useState<Message[]>(() => readLocalChats()[0]?.messages ?? [])
  const [draft, setDraft] = useState('')
  const [pendingFiles, setPendingFiles] = useState<File[]>([])
  const [signedAttachmentUrls, setSignedAttachmentUrls] = useState<Record<string, string>>({})
  const [usedToday, setUsedToday] = useState(() => getLocalUsage())
  const [isSending, setIsSending] = useState(false)
  const [isListening, setIsListening] = useState(false)
  const [isLoadingMessages, setIsLoadingMessages] = useState(false)
  const [isSidebarOpen, setIsSidebarOpen] = useState(false)
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false)
  const [isAccountOpen, setIsAccountOpen] = useState(false)
  const [isSettingsOpen, setIsSettingsOpen] = useState(false)
  const [authMode, setAuthMode] = useState<AuthMode>('signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [isPasswordVisible, setIsPasswordVisible] = useState(false)
  const [nameDraft, setNameDraft] = useState('')
  const [authError, setAuthError] = useState('')
  const [isAuthBusy, setIsAuthBusy] = useState(false)
  const [toast, setToast] = useState('')
  const [isThinking, setIsThinking] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const speechRecognitionRef = useRef<SpeechRecognitionLike | null>(null)
  const t = translations[locale]
  const studentName = getUserName(authUser, localName, locale)
  const isRegistered = Boolean(authUser && !authUser.is_anonymous)
  const hasSupabaseConfig = Boolean(supabase)

  useEffect(() => {
    document.documentElement.lang = locale
    document.documentElement.dir = t.direction
    document.documentElement.dataset.theme = theme
    document.title = `${t.brand} | ${t.advisor}`
    if (cookieConsent) savePreferences(locale, theme)
  }, [locale, theme, cookieConsent, t.direction, t.brand, t.advisor])

  useEffect(() => {
    const client = supabase
    if (!client) return

    let isActive = true
    const { data: listener } = client.auth.onAuthStateChange((_event, session) => {
      setAuthUser(session?.user ?? null)
      setAuthReady(true)
    })

    client.auth.getSession().then(async ({ data, error }) => {
      if (!isActive) return
      if (error) {
        setGuestAuthFailed(true)
        setAuthReady(true)
        return
      }
      if (data.session?.user) {
        setAuthUser(data.session.user)
        setAuthReady(true)
        return
      }
      const { data: guestData, error: guestError } = await client.auth.signInAnonymously()
      if (!isActive) return
      if (guestError || !guestData.user) {
        setGuestAuthFailed(true)
        setAuthReady(true)
        return
      }
      setGuestAuthFailed(false)
      setAuthUser(guestData.user)
      setAuthReady(true)
    }).catch(() => {
      if (!isActive) return
      setGuestAuthFailed(true)
      setAuthReady(true)
    })

    return () => {
      isActive = false
      listener.subscription.unsubscribe()
    }
  }, [])

  useEffect(() => {
    if (!supabase || !authUser || authUser.is_anonymous) return
    void supabase.rpc('preserve_registered_conversations')
  }, [authUser])

  useEffect(() => {
    if (!authReady) return

    const loadHistory = async () => {
      if (!supabase || !authUser) {
        const localChats = readLocalChats()
        setConversations(localChats)
        setActiveId(localChats[0]?.id ?? null)
        setMessages(localChats[0]?.messages ?? [])
        setUsedToday(getLocalUsage())
        return
      }

      const { data, error } = await supabase
        .from('conversations')
        .select('id, title, updated_at, guest_expires_at')
        .order('updated_at', { ascending: false })

      if (error) {
        notify(t.databaseLoadError)
        return
      }

      const savedConversations = (data ?? []) as Conversation[]
      setConversations(savedConversations)
      const firstConversation = savedConversations[0]
      setActiveId(firstConversation?.id ?? null)

      if (firstConversation) {
        const { data: savedMessages } = await supabase
          .from('messages')
          .select('id, role, content, created_at, attachments, is_out_of_scope, reply_to')
          .eq('conversation_id', firstConversation.id)
          .order('created_at', { ascending: true })
        const loadedMessages = (savedMessages ?? []) as Message[]
        setMessages(loadedMessages)
        void resolveAttachmentUrls(loadedMessages)
      } else {
        setMessages([])
      }

      const { data: usage } = await supabase.rpc('get_daily_usage')
      setUsedToday(Number(usage ?? 0))
    }

    void loadHistory()
  }, [authReady, authUser, t.databaseLoadError])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [messages, isLoadingMessages])

  useEffect(() => {
    if (isRegistered || conversations.length === 0) return
    const getExpiry = (conversation: Conversation) => authUser?.is_anonymous
      ? Date.parse(conversation.guest_expires_at ?? conversation.updated_at) + GUEST_CHAT_TTL_MS
      : Date.parse(conversation.updated_at) + GUEST_CHAT_TTL_MS
    const nextExpiry = Math.min(...conversations.map(getExpiry))
    const timer = window.setTimeout(() => {
      const remaining = authUser?.is_anonymous
        ? conversations.filter((conversation) => getExpiry(conversation) > Date.now())
        : readLocalChats()
      setConversations(remaining)
      if (activeId && !remaining.some((conversation) => conversation.id === activeId)) {
        setActiveId(null)
        setMessages([])
      }
    }, Math.max(nextExpiry - Date.now(), 0) + 25)
    return () => window.clearTimeout(timer)
  }, [authUser, isRegistered, conversations, activeId])

  useEffect(() => () => speechRecognitionRef.current?.stop(), [])

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(''), 3400)
    return () => window.clearTimeout(timer)
  }, [toast])

  function notify(message: string) {
    setToast(message)
  }

  function chooseCookieConsent(choice: Exclude<CookieConsent, null>) {
    writeCookie('daleel_cookie_consent', choice)
    setCookieConsent(choice)
    const name = cookieNameDraft.trim()
    if (choice === 'all' && name) {
      writeCookie('daleel_student_name', name)
      setLocalName(name)
    } else {
      removeGuestName()
      setLocalName(name)
    }
  }

  function updateLocale(nextLocale: AppLocale) {
    setLocale(nextLocale)
    writeCookie('daleel_locale', nextLocale)
  }

  function updateTheme(nextTheme: AccentTheme) {
    setTheme(nextTheme)
    writeCookie('daleel_theme', nextTheme)
  }

  function closeSidebar() {
    if (window.matchMedia('(max-width: 760px)').matches) {
      setIsSidebarOpen(false)
    } else {
      setIsSidebarCollapsed(true)
    }
  }

  function revealSidebar() {
    if (window.matchMedia('(max-width: 760px)').matches) {
      setIsSidebarOpen(true)
    } else {
      setIsSidebarCollapsed(false)
    }
  }

  function startNewChat() {
    setActiveId(null)
    setMessages([])
    setDraft('')
    setPendingFiles([])
    setIsSidebarOpen(false)
  }

  async function resolveAttachmentUrls(items: Message[]) {
    const client = supabase
    if (!client) return
    const attachments = items.flatMap((item) => item.attachments ?? [])
    const paths = [...new Set(attachments.map((attachment) => attachment.path))]
    if (!paths.length) return

    const results = await Promise.all(paths.map(async (path) => {
      const { data } = await client.storage.from(ATTACHMENT_BUCKET).createSignedUrl(path, 3600)
      return data?.signedUrl ? [path, data.signedUrl] as const : null
    }))
    setSignedAttachmentUrls((current) => ({
      ...current,
      ...Object.fromEntries(results.filter((result): result is readonly [string, string] => result !== null)),
    }))
  }

  function handleFileSelection(fileList: FileList | null) {
    if (!fileList?.length) return
    if (!supabase || !isRegistered) {
      notify(t.signInForFiles)
      return
    }

    const selectedFiles = Array.from(fileList)
    const tooLarge = selectedFiles.find((file) => file.size > MAX_FILE_SIZE)
    if (tooLarge) {
      notify(t.fileTooLarge)
      return
    }
    const unsupportedFile = selectedFiles.find((file) => !ALLOWED_MIME_TYPES.has(file.type))
    if (unsupportedFile) {
      notify(t.unsupportedFile.replace('{name}', unsupportedFile.name))
      return
    }
    if (pendingFiles.length + selectedFiles.length > MAX_ATTACHMENTS) {
      notify(t.tooManyFiles.replace('{count}', String(MAX_ATTACHMENTS)))
      return
    }
    setPendingFiles((current) => [...current, ...selectedFiles])
  }

  function toggleVoiceInput() {
    if (speechRecognitionRef.current) {
      playUiSound('voice')
      speechRecognitionRef.current.stop()
      return
    }

    const browserWindow = window as SpeechRecognitionWindow
    const SpeechRecognition = browserWindow.SpeechRecognition ?? browserWindow.webkitSpeechRecognition
    if (!SpeechRecognition) {
      notify(t.micUnsupported)
      return
    }

    const recognition = new SpeechRecognition()
    recognition.lang = locale === 'ar' ? 'ar' : locale === 'he' ? 'he-IL' : 'en-US'
    recognition.interimResults = false
    recognition.onresult = (event) => {
      const transcript = event.results[0]?.[0]?.transcript?.trim()
      if (transcript) setDraft((current) => current ? `${current} ${transcript}` : transcript)
    }
    recognition.onerror = () => {
      setIsListening(false)
      speechRecognitionRef.current = null
      notify(t.micPermission)
    }
    recognition.onend = () => {
      setIsListening(false)
      speechRecognitionRef.current = null
    }
    speechRecognitionRef.current = recognition
    setIsListening(true)
    try {
      recognition.start()
      playUiSound('voice')
    } catch {
      setIsListening(false)
      speechRecognitionRef.current = null
      notify(t.micPermission)
    }
  }

  async function openConversation(conversation: Conversation) {
    setActiveId(conversation.id)
    setIsSidebarOpen(false)
    if (!supabase || !authUser) {
      const saved = readLocalChats().find((item) => item.id === conversation.id)
      setMessages(saved?.messages ?? [])
      return
    }

    setIsLoadingMessages(true)
    const { data, error } = await supabase
      .from('messages')
      .select('id, role, content, created_at, attachments, is_out_of_scope, reply_to')
      .eq('conversation_id', conversation.id)
      .order('created_at', { ascending: true })
    if (error) notify(t.conversationLoadError)
    const loadedMessages = (data ?? []) as Message[]
    setMessages(loadedMessages)
    void resolveAttachmentUrls(loadedMessages)
    setIsLoadingMessages(false)
  }

  async function sendMessage(content = draft) {
    const trimmed = content.trim()
    if ((!trimmed && pendingFiles.length === 0) || isSending) return
    if (trimmed.length > MAX_MESSAGE_LENGTH) {
      notify(t.messageTooLong)
      return
    }
    if (usedToday >= DAILY_LIMIT) {
      notify(t.dailyLimitReached)
      return
    }
    if (pendingFiles.length && (!supabase || !isRegistered)) {
      notify(t.signInForFiles)
      return
    }
    if (supabase && !authUser) {
      notify(t.guestAuthError)
      return
    }

    playUiSound('send')
    setIsSending(true)
    const now = new Date().toISOString()
    const conversationId = activeId ?? crypto.randomUUID()
    const messageContent = trimmed || pendingFiles.map((file) => file.name).join(', ')
    const title = messageContent.length > 42 ? `${messageContent.slice(0, 42)}...` : messageContent
    const conversation: Conversation = {
      id: conversationId,
      title: activeId ? (conversations.find((item) => item.id === activeId)?.title ?? title) : title,
      updated_at: now,
      guest_expires_at: authUser?.is_anonymous ? new Date(Date.now() + GUEST_CHAT_TTL_MS).toISOString() : null,
    }
    let uploadedAttachments: MessageAttachment[] = []

    if (pendingFiles.length && supabase && authUser) {
      const client = supabase
      const ownerId = authUser.id
      const uploads: Array<{ attachment: MessageAttachment } | { error: string }> = await Promise.all(pendingFiles.map(async (file) => {
        const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_')
        const path = `${ownerId}/${conversationId}/${crypto.randomUUID()}-${safeName}`
        const { error } = await client.storage.from(ATTACHMENT_BUCKET).upload(path, file, {
          cacheControl: '3600',
          contentType: file.type || 'application/octet-stream',
          upsert: false,
        })
        return error ? { error: error.message } : { attachment: { name: file.name, path, type: file.type, size: file.size } }
      }))
      const failedUpload = uploads.find((upload) => 'error' in upload)
      if (failedUpload) {
        const uploadedPaths = uploads.flatMap((upload) => 'attachment' in upload ? [upload.attachment.path] : [])
        if (uploadedPaths.length) await client.storage.from(ATTACHMENT_BUCKET).remove(uploadedPaths)
        notify(t.uploadFailed)
        setIsSending(false)
        return
      }
      uploadedAttachments = uploads.flatMap((upload) => 'attachment' in upload ? [upload.attachment] : [])
    }

    const message: Message = {
      id: crypto.randomUUID(),
      role: 'user',
      content: messageContent,
      created_at: now,
      attachments: uploadedAttachments,
    }
    const nextMessages = [...messages, message]

    setActiveId(conversationId)
    setMessages(nextMessages)
    setDraft('')
    setConversations((current) => [conversation, ...current.filter((item) => item.id !== conversationId)])

    if (supabase && authUser) {
      setIsThinking(true)
      const { data, error } = await supabase.rpc('save_user_message', {
        p_conversation_id: conversationId,
        p_message_id: message.id,
        p_content: message.content,
        p_title: conversation.title,
        p_attachments: uploadedAttachments,
      })
      setIsThinking(false)
      const result = (Array.isArray(data) ? data[0] : data) as { allowed: boolean; used: number } | null
      if (error || !result?.allowed) {
        setMessages(messages)
        setDraft(trimmed)
        if (!activeId) {
          setActiveId(null)
          setConversations((current) => current.filter((item) => item.id !== conversationId))
        }
        if (result) setUsedToday(Number(result.used))
        if (uploadedAttachments.length) {
          await supabase.storage.from(ATTACHMENT_BUCKET).remove(uploadedAttachments.map((attachment) => attachment.path))
        }
        notify(error ? t.messageSaveError : t.quotaExhausted)
        setIsSending(false)
        return
      }
      setUsedToday(Number(result.used))
      setPendingFiles([])
      void resolveAttachmentUrls([message])
      setIsThinking(true)
      const { data: advisorResult, error: advisorError } = await supabase.functions.invoke('academic-advisor', {
        body: {
          conversation_id: conversationId,
          user_message_id: message.id,
          preferred_language: locale,
        },
      })
      setIsThinking(false)
      const assistantMessage = advisorResult?.message as Message | undefined
      if (advisorError || !assistantMessage) {
        notify(t.advisorUnavailable)
      } else {
        setMessages((current) => [...current, assistantMessage])
      }
    } else {
      const nextUsage = getLocalUsage() + 1
      localStorage.setItem(getTodayKey(), String(nextUsage))
      setUsedToday(nextUsage)
      const localChats = readLocalChats().filter((item) => item.id !== conversationId)
      localChats.unshift({ ...conversation, messages: nextMessages })
      localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(localChats))
      notify(t.messageSavedGuest)
    }

    setIsSending(false)
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void sendMessage()
    }
  }

  function openAccount() {
    setNameDraft(authUser?.user_metadata?.full_name ?? localName)
    setEmail(authUser?.email ?? '')
    setPassword('')
    setConfirmPassword('')
    setAuthMode(authUser?.is_anonymous ? 'signup' : 'signin')
    setAuthError('')
    setIsAccountOpen(true)
  }

  async function saveName() {
    const value = nameDraft.trim()
    if (!value) {
      setAuthError(t.nameSaveRequired)
      return
    }
    if (supabase && authUser) {
      const { error } = await supabase.auth.updateUser({ data: { full_name: value } })
      if (error) {
        setAuthError(t.nameSaveError)
        return
      }
    } else if (cookieConsent === 'all') {
      writeCookie('daleel_student_name', value)
    }
    setLocalName(value)
    setAuthError('')
    notify(t.profileSaved)
  }

  async function handleEmailAuth(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setAuthError('')
    if (!supabase) {
      setAuthError(t.supabaseConfigRequired)
      return
    }
    if (authMode === 'signup' && !nameDraft.trim()) {
      setAuthError(t.nameRequired)
      return
    }
    if (authMode === 'signup' && password !== confirmPassword) {
      setAuthError(t.passwordMismatch)
      return
    }
    setIsAuthBusy(true)
    if (authMode === 'signup' && authUser?.is_anonymous) {
      const { error } = await supabase.auth.updateUser({
        email,
        password,
        data: { full_name: nameDraft.trim() },
      })
      setIsAuthBusy(false)
      if (error) {
        setAuthError(error.message)
        return
      }
      setIsAccountOpen(false)
      notify(t.accountLinked)
      return
    }
    const result = authMode === 'signup'
      ? await supabase.auth.signUp({ email, password, options: { data: { full_name: nameDraft.trim() } } })
      : await supabase.auth.signInWithPassword({ email, password })
    setIsAuthBusy(false)
    if (result.error) {
      setAuthError(result.error.message)
      return
    }
    if (authMode === 'signup' && !result.data.session) {
      setAuthError(t.emailConfirmation)
    } else {
      setIsAccountOpen(false)
      notify(authMode === 'signup' ? t.signupSuccess : t.loginSuccess)
    }
  }

  async function signOut() {
    if (supabase) await supabase.auth.signOut()
    setIsAccountOpen(false)
    notify(t.signedOut)
  }

  return (
    <div className="app-shell" dir={t.direction}>
      {isSidebarOpen && <button className="scrim show" aria-label={t.closeSidebar} onClick={() => setIsSidebarOpen(false)} />}
      <aside className={`sidebar ${isSidebarOpen ? 'open' : ''} ${isSidebarCollapsed ? 'collapsed' : ''}`}>
        <div className="brand-row">
          <div className="brand-lockup">
            <div className="brand-mark"><img className="brand-icon" src="/daleel-icon.svg" alt="" /></div>
            <div>
              <div className="brand-name">{t.brand}</div>
              <div className="brand-caption">{t.university}</div>
            </div>
          </div>
          <button className="icon-button sidebar-close" title={t.closeSidebar} aria-label={t.closeSidebar} onClick={closeSidebar}><X size={18} /></button>
        </div>

        <button className="new-chat" onClick={startNewChat}>
          <Plus size={17} /> <span>{t.newChat}</span>
        </button>

        <div className="side-label">{t.history}</div>
        <div className="history-list">
          {conversations.length ? conversations.map((conversation) => (
            <button
              className={`history-item ${activeId === conversation.id ? 'active' : ''}`}
              key={conversation.id}
              onClick={() => void openConversation(conversation)}
              title={conversation.title}
            >
              <MessageSquareText size={15} />
              <span className="history-title">{conversation.title}</span>
            </button>
          )) : <div className="history-empty">{t.noHistory}</div>}
        </div>

        <div className="sidebar-spacer" />
        <button className="settings-entry" onClick={() => { setIsSettingsOpen(true); setIsSidebarOpen(false) }}>
          <Settings size={16} /> <span>{t.settings}</span>
        </button>
        <section className="daily-meter" aria-label={t.dailyLimitLabel}>
          <div className="meter-heading"><span>{t.dailyMessages}</span><span className="meter-count">{Math.min(usedToday, DAILY_LIMIT)} / {DAILY_LIMIT}</span></div>
          <div className="meter-track"><div className="meter-fill" style={{ width: `${Math.min((usedToday / DAILY_LIMIT) * 100, 100)}%` }} /></div>
          <div className="meter-note">{t.renewLimit}</div>
        </section>

        <button className="account-card" onClick={openAccount}>
          <span className="avatar">{studentName.trim().charAt(0)}</span>
          <span className="account-copy">
            <span className="account-name">{studentName}</span>
            <span className="account-email">{isRegistered ? authUser?.email : t.signIn}</span>
          </span>
          <ChevronDown size={16} color="#87918c" />
        </button>
        {isRegistered && <button className="sidebar-signout" onClick={() => void signOut()}><LogOut size={15} /><span>{t.signOut}</span></button>}
        <footer className="sidebar-footer">
          <span>{t.copyright}</span>
          <span>{t.designedBy} Eng.Mohammad.Y.Shabaneh</span>
        </footer>
      </aside>

      <main className="main-panel">
        <header className="topbar">
          <button className={`icon-button sidebar-reveal ${isSidebarCollapsed ? 'visible' : ''}`} title={isSidebarCollapsed ? t.openSidebar : t.mobileMenu} aria-label={isSidebarCollapsed ? t.openSidebar : t.mobileMenu} onClick={revealSidebar}>{isSidebarCollapsed ? <PanelLeftOpen size={19} /> : <Menu size={20} />}</button>
          <div className="topbar-title">{t.advisor}</div>
          <div className="topbar-actions">
            <button className="icon-button" title={t.profile} aria-label={t.profile} onClick={openAccount}><span className="avatar" style={{ width: 30, height: 30, flexBasis: 30, fontSize: 12 }}>{studentName.trim().charAt(0)}</span></button>
          </div>
        </header>

        <section className="chat-stage">
          {!authReady || isLoadingMessages ? <div className="loading-state">{t.loading}</div> : messages.length === 0 ? (
            <div className="welcome">
              <div className="welcome-kicker"><Sparkles size={15} /> {t.welcomeKicker}</div>
              <h1>{localName || authUser?.user_metadata?.full_name ? <>{t.greetingBack} {studentName}</> : t.greeting}<br /><span>{t.welcomeQuestion}</span></h1>
              <p className="welcome-copy">{t.welcomeCopy}</p>
              <div className="suggestion-grid">
                {(t.suggestions as readonly string[]).map((text, index) => {
                  const Icon = suggestionIcons[index]
                  return (
                  <button className="suggestion" key={text} onClick={() => { setDraft(text); void sendMessage(text) }}>
                    <span className="suggestion-text">{text}</span>
                    <span className="suggestion-icon"><Icon size={16} /></span>
                  </button>
                  )
                })}
              </div>
            </div>
          ) : (
            <div className="messages" role="log" aria-live="polite">
              {messages.map((message) => (
                <article className={`message-row ${message.role}`} key={message.id}>
                  <span className={`message-avatar ${message.is_out_of_scope ? 'out-of-scope-avatar' : ''}`}>
                    {message.role === 'user' ? studentName.trim().charAt(0) : message.is_out_of_scope ? <Frown size={18} /> : <BrainCircuit size={16} />}
                  </span>
                  <div>
                    <div className="message-bubble" dir="auto">{message.content}</div>
                    {message.attachments?.length ? (
                      <div className="message-attachments">
                        {message.attachments.map((attachment) => (
                          <a className="message-attachment" href={signedAttachmentUrls[attachment.path]} aria-disabled={!signedAttachmentUrls[attachment.path]} key={attachment.path} onClick={(event) => { if (!signedAttachmentUrls[attachment.path]) event.preventDefault() }} target="_blank" rel="noreferrer" aria-label={t.openAttachment.replace('{name}', attachment.name)}>
                            {attachment.type.startsWith('image/') && signedAttachmentUrls[attachment.path]
                              ? <img src={signedAttachmentUrls[attachment.path]} alt={attachment.name} />
                              : <FileText size={16} />}
                            <span>{attachment.name}</span>
                          </a>
                        ))}
                      </div>
                    ) : null}
                    <div className="message-time">{new Date(message.created_at).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })}</div>
                  </div>
                </article>
              ))}
              {isThinking && <div className="agent-thinking"><span className="thinking-icon"><BrainCircuit size={22} /></span><span>{t.thinking}</span></div>}
              <div ref={messagesEndRef} />
            </div>
          )}

          {hasSupabaseConfig && authReady && !authUser && guestAuthFailed && (
            <div className="guest-auth-notice">
              <span>{t.guestAuthError}</span>
              <button type="button" onClick={openAccount}>{t.signIn}</button>
            </div>
          )}

          <div className="composer-wrap">
            <div className="composer">
              {pendingFiles.length > 0 && (
                <div className="pending-files" aria-label={t.attachedFiles}>
                  {pendingFiles.map((file, index) => (
                    <span className="pending-file" key={`${file.name}-${file.lastModified}-${index}`}>
                      <Paperclip size={13} />
                      <span>{file.name}</span>
                      <button type="button" className="remove-file" aria-label={`${t.fileRemove}: ${file.name}`} onClick={() => setPendingFiles((current) => current.filter((_, fileIndex) => fileIndex !== index))}><X size={13} /></button>
                    </span>
                  ))}
                </div>
              )}
              <textarea
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={handleComposerKeyDown}
                maxLength={MAX_MESSAGE_LENGTH}
                placeholder={t.composerPlaceholder}
                aria-label={t.composerPlaceholder}
                rows={2}
              />
              <input
                ref={fileInputRef}
                className="visually-hidden"
                type="file"
                multiple
                accept="image/jpeg,image/png,image/webp,image/gif,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv"
                onChange={(event) => {
                  handleFileSelection(event.currentTarget.files)
                  event.currentTarget.value = ''
                }}
                aria-label={t.filePicker}
              />
              <div className="composer-tools">
                <div className="tool-group">
                  <button className="icon-button composer-tool-button" type="button" title={t.attach} aria-label={t.attach} disabled={isSending} onClick={() => fileInputRef.current?.click()}><Paperclip size={17} /></button>
                  <button className={`icon-button composer-tool-button ${isListening ? 'listening' : ''}`} type="button" title={isListening ? t.stopVoice : t.voice} aria-label={isListening ? t.stopVoice : t.voice} aria-pressed={isListening} onClick={toggleVoiceInput}>{isListening ? <MicOff size={17} /> : <Mic size={17} />}</button>
                  <span className="composer-shortcut">{t.shortcut}</span>
                </div>
                <button className="send-button" aria-label={t.send} title={t.send} disabled={(!draft.trim() && pendingFiles.length === 0) || isSending || (hasSupabaseConfig && !authUser)} onClick={() => void sendMessage()}>
                  {isSending ? <span className="animate-pulse"><Sparkles size={17} /></span> : <Send size={16} />}
                </button>
              </div>
            </div>
            <div className="composer-hint">{t.privacyHint}</div>
          </div>
        </section>
      </main>

      {isAccountOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setIsAccountOpen(false) }}>
          <section className="account-modal" role="dialog" aria-modal="true" aria-labelledby="account-title">
            <div className="modal-head">
              <div>
                <div className="modal-title" id="account-title">{isRegistered ? t.accountTitle : t.guestTitle}</div>
                <div className="modal-subtitle">{isRegistered ? t.accountDescription : t.guestDescription}</div>
              </div>
              <button className="icon-button" aria-label={t.close} onClick={() => setIsAccountOpen(false)}><X size={18} /></button>
            </div>

            {(isRegistered || (authMode === 'signin' && !authUser)) && <>
              <label className="field-label" htmlFor="student-name">{t.displayName}</label>
              <input className="text-field" id="student-name" value={nameDraft} onChange={(event) => setNameDraft(event.target.value)} placeholder={t.namePlaceholder} />
              <button className="secondary-action" style={{ marginTop: 9 }} onClick={() => void saveName()}><Check size={15} /> {t.saveAccount}</button>
            </>}

            {isRegistered ? (
              <button className="secondary-action" style={{ marginTop: 10 }} onClick={() => void signOut()}><LogOut size={15} /> {t.signOut}</button>
            ) : (
              <>
                {authUser?.is_anonymous && <div className="guest-upgrade-note">{authMode === 'signup' ? t.guestUpgrade : t.guestSignInWarning}</div>}
                <div className="divider">{authUser?.is_anonymous ? t.signUp : t.orSignIn}</div>
                <div className="divider">{t.email}</div>
                <form onSubmit={(event) => void handleEmailAuth(event)}>
                  {guestAuthFailed && <div className="modal-error" role="alert">{t.guestAuthError}</div>}
                  {authMode === 'signup' && <>
                    <label className="field-label" htmlFor="signup-name">{t.displayName}</label>
                    <input className="text-field" id="signup-name" required autoComplete="name" value={nameDraft} onChange={(event) => setNameDraft(event.target.value)} placeholder={t.namePlaceholder} />
                  </>}
                  <label className="field-label" htmlFor="student-email">{t.email}</label>
                  <input className="text-field" id="student-email" type="email" required autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="name@example.com" dir="ltr" lang="en" />
                  <label className="field-label" htmlFor="student-password">{t.password}</label>
                  <div className="password-field">
                    <input className="text-field" id="student-password" type={isPasswordVisible ? 'text' : 'password'} required minLength={6} autoComplete={authMode === 'signup' ? 'new-password' : 'current-password'} value={password} onChange={(event) => setPassword(event.target.value)} placeholder={t.passwordPlaceholder} dir="ltr" lang="en" />
                    <button className="password-toggle" type="button" aria-label={isPasswordVisible ? t.hidePassword : t.showPassword} title={isPasswordVisible ? t.hidePassword : t.showPassword} onClick={() => setIsPasswordVisible((visible) => !visible)}>{isPasswordVisible ? <EyeOff size={17} /> : <Eye size={17} />}</button>
                  </div>
                  {authMode === 'signup' && <>
                    <label className="field-label" htmlFor="student-confirm-password">{t.confirmPassword}</label>
                    <div className="password-field">
                      <input className="text-field" id="student-confirm-password" type={isPasswordVisible ? 'text' : 'password'} required minLength={6} autoComplete="new-password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} placeholder={t.confirmPassword} dir="ltr" lang="en" />
                      <button className="password-toggle" type="button" aria-label={isPasswordVisible ? t.hidePassword : t.showPassword} title={isPasswordVisible ? t.hidePassword : t.showPassword} onClick={() => setIsPasswordVisible((visible) => !visible)}>{isPasswordVisible ? <EyeOff size={17} /> : <Eye size={17} />}</button>
                    </div>
                  </>}
                  <button className="primary-action" type="submit" disabled={isAuthBusy}>{isAuthBusy ? t.thinking : authMode === 'signin' ? t.signIn : t.signUp}</button>
                </form>
                <button className="modal-toggle" onClick={() => { setAuthMode(authMode === 'signin' ? 'signup' : 'signin'); setAuthError('') }}>
                  {authMode === 'signin' ? t.switchToSignup : t.switchToSignin}
                </button>
              </>
            )}
            {authError && <div className="modal-error" role="alert">{authError}</div>}
            {!hasSupabaseConfig && <div className="modal-error">VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY</div>}
          </section>
        </div>
      )}

      {isSettingsOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setIsSettingsOpen(false) }}>
          <section className="account-modal settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title">
            <div className="modal-head">
              <div><div className="modal-title" id="settings-title">{t.settingsTitle}</div><div className="modal-subtitle">{t.settings}</div></div>
              <button className="icon-button" aria-label={t.close} onClick={() => setIsSettingsOpen(false)}><X size={18} /></button>
            </div>
            <label className="field-label">{t.language}</label>
            <div className="language-options" role="group" aria-label={t.language}>
              {locales.map((item) => {
                const languageNames = { ar: t.languageArabic, en: t.languageEnglish, he: t.languageHebrew }
                return <button type="button" key={item} className={`language-option ${locale === item ? 'selected' : ''}`} aria-pressed={locale === item} onClick={() => updateLocale(item)}>{languageNames[item]}</button>
              })}
            </div>
            <label className="field-label">{t.theme}</label>
            <div className="theme-options" role="group" aria-label={t.theme}>
              {([
                { id: 'green', label: t.themeGreen, color: '#1c6655' },
                { id: 'ocean', label: t.themeOcean, color: '#236b86' },
                { id: 'coral', label: t.themeRose, color: '#b4534b' },
                { id: 'gold', label: t.themeGold, color: '#94721b' },
              ] as const).map((option) => (
                <button type="button" key={option.id} className={`theme-option ${theme === option.id ? 'selected' : ''}`} aria-label={option.label} aria-pressed={theme === option.id} onClick={() => updateTheme(option.id)}>
                  <span className="theme-swatch" style={{ background: option.color }} />
                  <span>{option.label}</span>
                </button>
              ))}
            </div>
            <div className="settings-save-note"><Check size={14} /> {t.saveSettings}</div>
          </section>
        </div>
      )}

      {cookieConsent === null && (
        <div className="modal-backdrop cookie-backdrop">
          <section className="account-modal cookie-modal" role="dialog" aria-modal="true" aria-labelledby="cookie-title">
            <div className="brand-mark cookie-mark"><img className="brand-icon" src="/daleel-icon.svg" alt="" /></div>
            <h2 className="modal-title" id="cookie-title">{t.cookieTitle}</h2>
            <p className="cookie-copy">{t.cookieDescription}</p>
            <label className="field-label" htmlFor="cookie-name">{t.cookieName}</label>
            <input className="text-field" id="cookie-name" value={cookieNameDraft} onChange={(event) => setCookieNameDraft(event.target.value)} placeholder={t.namePlaceholder} />
            <div className="cookie-actions">
              <button className="secondary-action" onClick={() => chooseCookieConsent('reject')}>{t.rejectAll}</button>
              <button className="primary-action" onClick={() => chooseCookieConsent('all')}>{t.acceptAll}</button>
            </div>
          </section>
        </div>
      )}

      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  )
}

export default App