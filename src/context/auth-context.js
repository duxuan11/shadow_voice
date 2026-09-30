import { createContext, useContext } from 'react'

// Context 与 hook 单独成文件：AuthContext.jsx 只导出 AuthProvider 组件，
// 这样 react-refresh/only-export-components 不再报错。
export const AuthContext = createContext(null)

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
