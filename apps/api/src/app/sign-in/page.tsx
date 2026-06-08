import { signIn } from '@/lib/auth'

export default function SignInPage() {
  return (
    <main style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', gap: 16, fontFamily: 'sans-serif' }}>
      <h1>mysuperdatabase</h1>
      <p>Sign in to continue</p>
      <form action={async () => { 'use server'; await signIn('github') }}>
        <button type="submit" style={{ padding: '10px 24px', borderRadius: 6, border: '1px solid #ccc', cursor: 'pointer', fontSize: 16 }}>
          Continue with GitHub
        </button>
      </form>
      <form action={async () => { 'use server'; await signIn('google') }}>
        <button type="submit" style={{ padding: '10px 24px', borderRadius: 6, border: '1px solid #ccc', cursor: 'pointer', fontSize: 16 }}>
          Continue with Google
        </button>
      </form>
    </main>
  )
}
