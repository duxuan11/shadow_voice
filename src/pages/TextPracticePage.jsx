import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ArrowLeft, Plus, FileText, Pencil, Trash2, ChevronRight, AlertTriangle,
  Loader2, Sparkles, X,
} from 'lucide-react'
import { useAuth } from '../context/auth-context'
import { statusLabel, formatDate, buildUpdatePayload } from '../utils/textPractice'

const MAX_TITLE = 100
const MAX_TEXT = 20000

const EMPTY_FORM = { id: null, title: '', text: '', originalText: '' }

// 文本练习列表页：粘贴任意英文（技术文档/README/邮件）→ 拆句 → 跟读 + 汉译英。
// 数据完全独立于视频学习（server/routes/texts.cjs）。
export default function TextPracticePage() {
  const navigate = useNavigate()
  const { authFetch, isGuest } = useAuth()

  const [docs, setDocs] = useState([])
  const [aiConfigured, setAiConfigured] = useState(true)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const [mode, setMode] = useState('list') // list | new | edit
  const [form, setForm] = useState(EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState(null)
  const [busyId, setBusyId] = useState(null)

  // 游客：文本练习依赖服务端存储，直接引导登录
  useEffect(() => {
    if (isGuest) navigate('/login', { state: { from: '/texts' } })
  }, [isGuest, navigate])

  const [reloadKey, setReloadKey] = useState(0)

  // 加载列表：effect 内自取（不在这里同步 setState，避免 cascading render）
  useEffect(() => {
    if (isGuest) return
    let cancelled = false
    ;(async () => {
      try {
        const res = await authFetch('/texts')
        if (res.status === 401) throw new Error('登录已过期，请重新登录')
        if (!res.ok) throw new Error('加载失败，请重试')
        const data = await res.json()
        if (cancelled) return
        setDocs(Array.isArray(data.docs) ? data.docs : [])
        setAiConfigured(!!data.aiConfigured)
      } catch (err) {
        if (!cancelled) setError(err.message || '加载失败，请重试')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [authFetch, isGuest, reloadKey])

  const reload = () => {
    setLoading(true)
    setError(null)
    setReloadKey((k) => k + 1)
  }

  const openNew = () => {
    setMode('new')
    setForm(EMPTY_FORM)
    setFormError(null)
  }

  const openEdit = async (doc) => {
    setError(null)
    setBusyId(doc.id)
    try {
      const res = await authFetch(`/texts/${doc.id}`)
      if (res.status === 404) throw new Error('文本不存在或已删除')
      if (!res.ok) throw new Error('打开失败，请重试')
      const data = await res.json()
      setMode('edit')
      setForm({
        id: data.doc.id,
        title: data.doc.title,
        text: data.doc.sourceText || '',
        originalText: data.doc.sourceText || '',
      })
      setFormError(null)
    } catch (err) {
      setError(err.message || '打开失败，请重试')
    } finally {
      setBusyId(null)
    }
  }

  const closeForm = () => {
    setMode('list')
    setForm(EMPTY_FORM)
    setFormError(null)
  }

  const submit = async () => {
    const title = form.title.trim()
    const text = form.text
    if (!title) { setFormError('请填写标题'); return }
    if (!text.trim()) { setFormError('请粘贴英文正文'); return }

    const textChanged = mode === 'edit' && text !== form.originalText
    if (textChanged) {
      const ok = window.confirm('修改正文会重新拆句并清空这篇文本的练习进度，继续？')
      if (!ok) return
    }

    setSaving(true)
    setFormError(null)
    try {
      const payload = mode === 'edit'
        ? buildUpdatePayload({ title, text, originalText: form.originalText })
        : { title, text }
      const res = mode === 'edit'
        ? await authFetch(`/texts/${form.id}`, { method: 'PUT', body: JSON.stringify(payload) })
        : await authFetch('/texts', { method: 'POST', body: JSON.stringify(payload) })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || '保存失败，请重试')
      navigate(`/texts/${data.doc.id}`)
    } catch (err) {
      setFormError(err.message || '保存失败，请重试')
      setSaving(false)
    }
  }

  const remove = async (doc) => {
    const ok = window.confirm(`删除后进度不可恢复，确定删除《${doc.title}》？`)
    if (!ok) return
    setBusyId(doc.id)
    try {
      const res = await authFetch(`/texts/${doc.id}`, { method: 'DELETE' })
      if (!res.ok && res.status !== 404) throw new Error('删除失败，请重试')
      setDocs((list) => list.filter((d) => d.id !== doc.id))
    } catch (err) {
      setError(err.message || '删除失败，请重试')
    } finally {
      setBusyId(null)
    }
  }

  if (isGuest) return null

  return (
    <div className="min-h-screen bg-slate-50">
      <div className="mx-auto w-full max-w-3xl px-4 py-5 space-y-4">
        <header className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => navigate('/profile')}
            className="flex items-center justify-center w-9 h-9 bg-white border border-slate-200 hover:bg-slate-100 text-slate-600 rounded-lg shrink-0 active:scale-95 cursor-pointer"
            title="返回个人中心"
          >
            <ArrowLeft className="h-4 w-4 stroke-[2.5]" />
          </button>
          <div className="min-w-0">
            <h1 className="text-base font-extrabold text-slate-800 tracking-tight">📄 文本练习</h1>
            <p className="text-[11px] text-slate-500 truncate">粘贴英文技术文档 / README / 邮件，练跟读与汉译英</p>
          </div>
          {mode === 'list' && (
            <button
              type="button"
              onClick={openNew}
              className="ml-auto shrink-0 flex items-center gap-1 px-3 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-xs font-bold cursor-pointer active:scale-95"
            >
              <Plus className="h-3.5 w-3.5" />粘贴新文本
            </button>
          )}
        </header>

        {!aiConfigured && mode === 'list' && (
          <div className="flex items-start gap-2 rounded-xl border border-amber-100 bg-amber-50 px-3 py-2 text-[11px] font-semibold text-amber-700">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
            <span>AI 未配置：文本可以保存与跟读，中文翻译与回译评分暂不可用。</span>
          </div>
        )}

        {mode !== 'list' && (
          <section className="rounded-2xl bg-white border border-slate-200 p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-extrabold text-slate-800">
                {mode === 'edit' ? '编辑文本' : '粘贴新文本'}
              </h2>
              <button type="button" onClick={closeForm} className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400 cursor-pointer" title="取消">
                <X className="h-4 w-4" />
              </button>
            </div>

            <label className="block space-y-1">
              <span className="text-[11px] font-bold text-slate-500">标题</span>
              <input
                value={form.title}
                onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
                maxLength={MAX_TITLE}
                placeholder="例如：U-Net 论文摘要"
                className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-800 outline-none focus:border-indigo-400"
              />
            </label>

            <label className="block space-y-1">
              <span className="text-[11px] font-bold text-slate-500">英文正文</span>
              <textarea
                value={form.text}
                onChange={(e) => setForm((f) => ({ ...f, text: e.target.value }))}
                maxLength={MAX_TEXT}
                rows={10}
                placeholder="把英文文档、README、论文摘要或邮件整段粘进来…"
                className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs font-mono leading-relaxed text-slate-800 outline-none focus:border-indigo-400"
              />
            </label>

            <div className="flex items-center justify-between text-[11px]">
              <span className="text-slate-400">
                支持 Markdown：标题、列表、表格会被正确拆分；代码块会被忽略。
              </span>
              <span className={form.text.length > 18000 ? 'text-rose-600 font-bold' : 'text-slate-400'}>
                {form.text.length}/{MAX_TEXT}
              </span>
            </div>

            {formError && (
              <p className="text-[11px] font-semibold text-rose-600">{formError}</p>
            )}

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={submit}
                disabled={saving}
                className="flex items-center gap-1.5 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:bg-slate-300 text-white rounded-lg text-xs font-bold cursor-pointer disabled:cursor-not-allowed"
              >
                {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
                {saving ? '保存中…' : mode === 'edit' ? '保存' : '保存并生成中文'}
              </button>
              <button type="button" onClick={closeForm} className="px-3 py-2 bg-slate-100 hover:bg-slate-200 text-slate-600 rounded-lg text-xs font-bold cursor-pointer">
                取消
              </button>
            </div>
          </section>
        )}

        {mode === 'list' && loading && (
          <div className="flex flex-col items-center justify-center gap-3 py-16">
            <div className="h-8 w-8 rounded-full border-4 border-indigo-200 border-t-indigo-600 animate-spin" />
            <p className="text-xs font-bold text-slate-500">加载中...</p>
          </div>
        )}

        {mode === 'list' && !loading && error && (
          <div className="flex flex-col items-center gap-3 py-12 text-center">
            <AlertTriangle className="h-7 w-7 text-rose-500" />
            <p className="text-sm text-slate-600">{error}</p>
            <button type="button" onClick={reload} className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-xs font-bold cursor-pointer">
              重试
            </button>
          </div>
        )}

        {mode === 'list' && !loading && !error && docs.length === 0 && (
          <div className="rounded-2xl bg-white border border-slate-200 px-4 py-10 text-center space-y-3">
            <FileText className="h-8 w-8 text-slate-300 mx-auto" />
            <p className="text-sm font-bold text-slate-600">还没有文本</p>
            <p className="text-[11px] text-slate-400">粘贴英文技术文档、论文摘要、README 或邮件，生成跟读与汉译英练习</p>
            <button type="button" onClick={openNew} className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-xs font-bold cursor-pointer">
              粘贴第一段
            </button>
          </div>
        )}

        {mode === 'list' && !loading && !error && docs.length > 0 && (
          <ul className="space-y-2.5">
            {docs.map((doc) => (
              <li key={doc.id} className="rounded-2xl bg-white border border-slate-200 p-3.5 space-y-2.5">
                <div className="flex items-start gap-2">
                  <button
                    type="button"
                    onClick={() => navigate(`/texts/${doc.id}`)}
                    className="flex-1 min-w-0 text-left cursor-pointer"
                  >
                    <h3 className="text-sm font-extrabold text-slate-800 truncate">{doc.title}</h3>
                    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-slate-500">
                      <span>{doc.sentenceCount} 句</span>
                      <span className="text-slate-300">·</span>
                      <span>跟读 {doc.shadowDone}/{doc.sentenceCount}</span>
                      <span className="text-slate-300">·</span>
                      <span>翻译 {doc.translateDone}/{doc.sentenceCount}</span>
                      {doc.truncated && <span className="text-amber-600">仅前 200 句</span>}
                      <span className="text-slate-300">·</span>
                      <span>{formatDate(doc.updatedAt)}</span>
                    </div>
                  </button>
                  <div className="shrink-0 flex flex-col items-end gap-1">
                    <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${
                      doc.status === 'completed'
                        ? 'bg-emerald-50 text-emerald-700 border-emerald-100'
                        : 'bg-slate-50 text-slate-500 border-slate-200'
                    }`}>
                      {statusLabel(doc.status)}
                    </span>
                    {!doc.cnReady && (
                      <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-100">
                        中文未生成
                      </span>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => navigate(`/texts/${doc.id}`)}
                    className="flex items-center gap-1 px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-[11px] font-bold cursor-pointer"
                  >
                    继续学习<ChevronRight className="h-3 w-3" />
                  </button>
                  <button
                    type="button"
                    onClick={() => openEdit(doc)}
                    disabled={busyId === doc.id}
                    className="flex items-center gap-1 px-2.5 py-1.5 bg-slate-100 hover:bg-slate-200 disabled:opacity-50 text-slate-600 rounded-lg text-[11px] font-bold cursor-pointer"
                  >
                    <Pencil className="h-3 w-3" />编辑
                  </button>
                  <button
                    type="button"
                    onClick={() => remove(doc)}
                    disabled={busyId === doc.id}
                    className="flex items-center gap-1 px-2.5 py-1.5 bg-white border border-rose-100 hover:bg-rose-50 disabled:opacity-50 text-rose-600 rounded-lg text-[11px] font-bold cursor-pointer"
                  >
                    <Trash2 className="h-3 w-3" />删除
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
