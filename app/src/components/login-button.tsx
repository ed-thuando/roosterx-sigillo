// Login page sign-in button — Firebase Google sign-in.
// signInWithPopup → Firebase ID token → POST /auth/session (Worker verifies the
// token and sets our own D1-backed session cookie). See AUTH_REWRITE.md.

"use client"

import { useState } from "react"
import { initializeApp, getApps, type FirebaseApp } from "firebase/app"
import { getAuth, GoogleAuthProvider, signInWithPopup } from "firebase/auth"
import { Button } from "sigillo-app/src/components/ui/button"

type FirebaseConfig = { apiKey: string; authDomain: string; projectId: string }

export function LoginButton({
  callbackURL = "/dash",
  firebaseConfig,
}: {
  callbackURL?: string
  firebaseConfig: FirebaseConfig
}) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSignIn() {
    setLoading(true)
    setError(null)
    try {
      if (!firebaseConfig.apiKey) throw new Error("Auth is not configured (missing Firebase web config)")
      const app: FirebaseApp = getApps()[0] ?? initializeApp(firebaseConfig)
      const auth = getAuth(app)
      const result = await signInWithPopup(auth, new GoogleAuthProvider())
      const idToken = await result.user.getIdToken()
      const res = await fetch("/auth/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ idToken }),
      })
      if (!res.ok) throw new Error("Could not create session")
      window.location.href = callbackURL
    } catch (e: any) {
      setError(e?.message || "Sign-in failed")
      setLoading(false)
    }
  }

  return (
    <div className="flex flex-col items-center gap-2">
      <Button onClick={handleSignIn} loading={loading} size="lg">
        {loading ? "Signing in…" : "Sign in with Google"}
      </Button>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  )
}
