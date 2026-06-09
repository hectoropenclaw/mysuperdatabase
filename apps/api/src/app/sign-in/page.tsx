'use client'

import { signIn } from 'next-auth/react'

export default function SignInPage({ searchParams }: { searchParams: Record<string, string> }) {
  const error = searchParams?.error

  return (
    <main style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      justifyContent: 'center', minHeight: '100vh', gap: 16,
      fontFamily: 'system-ui, sans-serif', background: '#0B0D14', color: '#E8ECF8'
    }}>
      <div style={{ fontSize: 28, fontWeight: 700, letterSpacing: -0.5 }}>supanow</div>
      <p style={{ color: '#8B95B5', margin: 0 }}>Sign in to continue</p>

      {error && (
        <p style={{ color: '#F87171', fontSize: 13, background: '#1c1c2a', padding: '8px 16px', borderRadius: 8 }}>
          {error === 'Configuration' ? 'Server configuration error — check logs.' : `Error: ${error}`}
        </p>
      )}

      <button
        onClick={() => signIn('github', { callbackUrl: '/' })}
        style={{
          padding: '10px 28px', borderRadius: 8, border: 'none',
          background: '#238636', color: '#fff', cursor: 'pointer',
          fontSize: 15, fontWeight: 500, marginTop: 8
        }}
      >
        Continue with GitHub
      </button>
    </main>
  )
}
