// Client component for generating and displaying org invite links.
// Supports role selection, shows pending invites with revoke capability.

"use client"

import { useState, useEffect } from "react"
import { router } from "spiceflow/react"
import { createInviteAction, revokeInviteAction } from "../actions.ts"
import { Button } from "sigillo-app/src/components/ui/button"
import {
  Dialog, DialogPopup, DialogHeader, DialogTitle,
  DialogDescription, DialogClose, DialogFooter,
} from "sigillo-app/src/components/ui/dialog"
import { LinkIcon, CopyIcon, CheckIcon, UserPlusIcon, Trash2Icon, BadgeCheckIcon, ClockIcon, ShieldIcon, UserIcon } from "lucide-react"
import { Input } from "sigillo-app/src/components/ui/input"
import { NativeSelect } from "sigillo-app/src/components/ui/native-select"
import { Badge } from "sigillo-app/src/components/ui/badge"
import { cn } from "sigillo-app/src/lib/utils"

type PendingInvite = {
  id: string
  role: "admin" | "member"
  createdAt: number
  expiresAt: number
  createdBy: string
}

export function InviteButton({ orgId }: { orgId: string }) {
  const [open, setOpen] = useState(false)

  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        <UserPlusIcon className="size-4" />
        Invite member
      </Button>
      <InviteDialog open={open} onOpenChange={setOpen} orgId={orgId} />
    </>
  )
}

function InviteDialog({ open, onOpenChange, orgId }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  orgId: string
}) {
  const [inviteUrl, setInviteUrl] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selectedRole, setSelectedRole] = useState<"admin" | "member">("member")
  const [pendingInvites, setPendingInvites] = useState<PendingInvite[]>([])
  const [loadingInvites, setLoadingInvites] = useState(true)
  const [revoking, setRevoking] = useState<string | null>(null)

  useEffect(() => {
    if (open) {
      loadPendingInvites()
    }
  }, [open])

  async function loadPendingInvites() {
    setLoadingInvites(true)
    try {
      const res = await fetch(`/api/v0/orgs/${orgId}/invites`)
      if (res.ok) {
        const data = await res.json() as { invites: PendingInvite[] }
        setPendingInvites(data.invites || [])
      }
    } catch {
      // ignore
    } finally {
      setLoadingInvites(false)
    }
  }

  async function handleGenerate() {
    setLoading(true)
    setError(null)
    try {
      const result = await createInviteAction({ orgId, role: selectedRole })
      setInviteUrl(`${window.location.origin}${router.href('/invite/:id', { id: result.id })}`)
      await loadPendingInvites()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to generate invite link')
    } finally {
      setLoading(false)
    }
  }

  async function handleRevoke(inviteId: string) {
    setRevoking(inviteId)
    try {
      await revokeInviteAction({ id: inviteId })
      await loadPendingInvites()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to revoke invite')
    } finally {
      setRevoking(null)
    }
  }

  async function handleCopy() {
    if (!inviteUrl) return
    await navigator.clipboard.writeText(inviteUrl)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  function handleOpenChange(open: boolean) {
    if (!open) {
      setInviteUrl(null)
      setCopied(false)
      setError(null)
      setSelectedRole("member")
    }
    onOpenChange(open)
  }

  function formatTime(ts: number): string {
    const date = new Date(ts)
    return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  }

  function isExpired(ts: number): boolean {
    return ts < Date.now()
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UserPlusIcon className="size-5 text-primary" />
            Invite member
          </DialogTitle>
          <DialogDescription>
            Generate an invite link with a role. The link expires in 7 days and grants access to
            <strong>all projects</strong> in this organization.
          </DialogDescription>
        </DialogHeader>
        <div className="px-6 pb-2">
          {error && (
            <p className="text-sm text-destructive mb-4">{error}</p>
          )}

          {inviteUrl ? (
            <div className="flex flex-col gap-3">
              <div className="rounded-lg bg-muted p-3 border border-border">
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-xs font-medium text-muted-foreground">Invite link</span>
                  <Badge variant="secondary" className="text-xs capitalize">{selectedRole}</Badge>
                </div>
                <div className="flex gap-2">
                  <Input
                    readOnly
                    value={inviteUrl}
                    className="w-full mono-sm text-xs"
                    onClick={(e) => e.currentTarget.select()}
                  />
                  <Button variant="outline" size="icon" onClick={handleCopy}>
                    {copied ? <CheckIcon className="size-4" /> : <CopyIcon className="size-4" />}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  Share this link. The invitee will receive the <strong>{selectedRole}</strong> role on join.
                </p>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <label className="flex flex-col gap-2 text-sm">
                <span className="font-medium">Role on join</span>
                <NativeSelect value={selectedRole} onChange={(e) => setSelectedRole(e.currentTarget.value as "admin" | "member")}>
                  <option value="member">Member — can view assigned environments</option>
                  <option value="admin">Admin — full organization access</option>
                </NativeSelect>
              </label>
              <Button onClick={handleGenerate} loading={loading} className="w-full">
                <LinkIcon className="size-4" />
                Generate invite link
              </Button>
            </div>
          )}

          {pendingInvites.length > 0 && (
            <div className="mt-6 pt-4 border-t border-border">
              <h4 className="text-sm font-medium text-muted-foreground mb-3">Pending invites</h4>
              {loadingInvites ? (
                <div className="text-center text-sm text-muted-foreground py-4">Loading...</div>
              ) : (
                <div className="space-y-2 max-h-48 overflow-y-auto">
                  {pendingInvites.map((invite) => {
                    const expired = isExpired(invite.expiresAt)
                    return (
                      <div key={invite.id} className="flex items-center justify-between p-3 rounded-lg bg-muted/50 border border-border/50">
                        <div className="flex items-center gap-3 min-w-0">
                          <div className={cn("flex items-center justify-center w-8 h-8 rounded-full text-xs font-medium", invite.role === 'admin' ? 'bg-destructive/10 text-destructive' : 'bg-primary/10 text-primary')}>
                            {invite.role === 'admin' ? <ShieldIcon className="size-4" /> : <UserIcon className="size-4" />}
                          </div>
                          <div className="min-w-0">
                            <p className="text-sm font-medium truncate">
                              {expired ? <span className="text-muted-foreground">Expired</span> : <span>Invite #{invite.id.slice(0, 8)}</span>}
                            </p>
                            <p className="text-xs text-muted-foreground flex items-center gap-1">
                              <ClockIcon className="size-3" /> Expires {formatTime(invite.expiresAt)}
                            </p>
                          </div>
                        </div>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => handleRevoke(invite.id)}
                          loading={revoking === invite.id}
                          disabled={revoking !== null && revoking !== invite.id}
                          className="text-destructive hover:bg-destructive/10"
                          title="Revoke invite"
                        >
                          <Trash2Icon className="size-4" />
                        </Button>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )}

          <DialogFooter variant="bare" className="mt-4">
            <DialogClose render={<Button variant="outline" />}>
              {inviteUrl ? "Done" : "Cancel"}
            </DialogClose>
          </DialogFooter>
        </div>
      </DialogPopup>
    </Dialog>
  )
}