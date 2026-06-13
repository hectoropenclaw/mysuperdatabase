export const dynamic = 'force-dynamic'

export default function SignInPage({ searchParams }: { searchParams: Record<string, string> }) {
  const error = searchParams?.error
  const githubEnabled = Boolean(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET)
  const googleEnabled = Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET)
  const hasProvider = githubEnabled || googleEnabled

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

      {githubEnabled && (
        <a
          href="/api/auth/signin/github?callbackUrl=%2F"
          style={{
            display: 'inline-block',
            padding: '10px 28px', borderRadius: 8, border: 'none',
            background: '#238636', color: '#fff', cursor: 'pointer',
            fontSize: 15, fontWeight: 500, marginTop: 8, textDecoration: 'none'
          }}
        >
          Continue with GitHub
        </a>
      )}

      {googleEnabled && (
        <a
          href="/api/auth/signin/google?callbackUrl=%2F"
          style={{
            display: 'inline-block',
            padding: '10px 28px', borderRadius: 8, border: '1px solid #3a4567',
            background: '#111522', color: '#fff', cursor: 'pointer',
            fontSize: 15, fontWeight: 500, textDecoration: 'none'
          }}
        >
          Continue with Google
        </a>
      )}

      {!hasProvider && (
        <p style={{ color: '#FBBF24', fontSize: 13, background: '#1c1c2a', padding: '8px 16px', borderRadius: 8 }}>
          No auth providers are configured yet. Set GitHub or Google OAuth env vars.
        </p>
      )}
    </main>
  )
}
