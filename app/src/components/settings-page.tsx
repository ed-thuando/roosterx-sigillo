// Settings page for org-level configuration.
// Contains a "Danger Zone" with project deletion and org deletion.
// The confirm dialogs make clear what will be removed.

'use client'

import { useState, useTransition } from 'react'
import { AlertTriangleIcon } from 'lucide-react'
import { useLoaderData } from 'spiceflow/react'
import { Button } from 'sigillo-app/src/components/ui/button'
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
  DialogClose,
} from 'sigillo-app/src/components/ui/dialog'
import { deleteOrgAction, deleteProjectAction } from '../actions.ts'

export function SettingsPage() {
  const { orgId, orgName, isOrgAdmin, canDeleteProject, projectId, projectName, projectNames } = useLoaderData('/dash/projects/:projectId/settings')
  const [open, setOpen] = useState(false)
  const [projectOpen, setProjectOpen] = useState(false)
  const [isPending, startTransition] = useTransition()

  function handleDelete() {
    startTransition(async () => {
      await deleteOrgAction({ orgId })
    })
  }

  function handleDeleteProject() {
    startTransition(async () => {
      await deleteProjectAction({ projectId })
    })
  }

  return (
    <div className="flex flex-col gap-6 w-full max-w-2xl">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Settings</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Manage your organization settings.
        </p>
      </div>

      {canDeleteProject && (
      <div className="rounded-2xl border border-(--danger-soft) bg-(--danger-soft)/30">
        <div className="p-4">
          <h2 className="text-lg font-semibold text-destructive flex items-center gap-2">
            <AlertTriangleIcon className="size-5" />
            Danger Zone
          </h2>
          <p className="text-muted-foreground text-sm mt-2">
            Deleting this project is permanent. All of its environments, secrets,
            tokens, and access grants will be removed immediately.
          </p>
        </div>
        <div className="border-t border-(--danger-soft) p-4 flex items-center justify-between">
          <div>
            <p className="text-sm font-medium">Delete project</p>
            <p className="text-xs text-muted-foreground">
              This action cannot be undone.
            </p>
          </div>
          <Dialog open={projectOpen} onOpenChange={setProjectOpen}>
            <Button
              variant="destructive"
              onClick={() => setProjectOpen(true)}
            >
              Delete project
            </Button>
            <DialogPopup>
              <DialogHeader>
                <DialogTitle>Delete {projectName}?</DialogTitle>
                <DialogDescription>
                  This will permanently delete the project and everything inside it.
                </DialogDescription>
              </DialogHeader>
              <div className="px-6 pb-4">
                <p className="text-sm text-muted-foreground">
                  Environments, secrets, tokens, and member access for this project
                  will be removed and cannot be recovered.
                </p>
              </div>
              <DialogFooter variant="bare" className="mt-4">
                <DialogClose
                  render={<Button variant="outline" />}
                >
                  Cancel
                </DialogClose>
                <Button
                  variant="destructive"
                  onClick={handleDeleteProject}
                  disabled={isPending}
                >
                  {isPending ? 'Deleting...' : 'Delete project'}
                </Button>
              </DialogFooter>
            </DialogPopup>
          </Dialog>
        </div>
      </div>
      )}

      {isOrgAdmin && (
      <div className="rounded-2xl border border-(--danger-soft) bg-(--danger-soft)/30">
        <div className="p-4">
          <h2 className="text-lg font-semibold text-destructive flex items-center gap-2">
            <AlertTriangleIcon className="size-5" />
            Danger Zone
          </h2>
          <p className="text-muted-foreground text-sm mt-2">
            Deleting this organization is permanent. All projects, environments,
            secrets, tokens, and member access will be removed immediately.
          </p>
        </div>
        <div className="border-t border-(--danger-soft) p-4 flex items-center justify-between">
          <div>
            <p className="text-sm font-medium">Delete organization</p>
            <p className="text-xs text-muted-foreground">
              This action cannot be undone.
            </p>
          </div>
          <Dialog open={open} onOpenChange={setOpen}>
            <Button
              variant="destructive"
              onClick={() => setOpen(true)}
            >
              Delete organization
            </Button>
            <DialogPopup>
              <DialogHeader>
                <DialogTitle>Delete {orgName}?</DialogTitle>
                <DialogDescription>
                  This will permanently delete the organization and everything inside it.
                </DialogDescription>
              </DialogHeader>
              <div className="px-6 pb-4">
                {projectNames.length > 0 ? (
                  <>
                    <p className="text-sm font-medium mb-2">
                      The following {projectNames.length === 1 ? 'project' : `${projectNames.length} projects`} will be deleted:
                    </p>
                    <ul className="text-sm text-muted-foreground space-y-1">
                      {projectNames.map((name) => (
                        <li key={name} className="flex items-center gap-2">
                          <span className="size-1.5 rounded-full bg-destructive shrink-0" />
                          {name}
                        </li>
                      ))}
                    </ul>
                  </>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    This organization has no projects.
                  </p>
                )}
              </div>
              <DialogFooter variant="bare" className="mt-4">
                <DialogClose
                  render={<Button variant="outline" />}
                >
                  Cancel
                </DialogClose>
                <Button
                  variant="destructive"
                  onClick={handleDelete}
                  disabled={isPending}
                >
                  {isPending ? 'Deleting...' : 'Delete organization'}
                </Button>
              </DialogFooter>
            </DialogPopup>
          </Dialog>
        </div>
      </div>
      )}
    </div>
  )
}
