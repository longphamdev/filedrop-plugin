// Target-directory state: the drop destination defaults to the workspace's own directory and
// snaps to the new workspace's directory when the panel's workspace changes. A manual edit or
// browse pick is preserved while the workspace stays put.

export interface TargetState {
  /** Workspace directory this target was derived from; null until the snapshot loads. */
  workspaceDir: string | null;
  target: string;
}

export function initTargetState(workspaceDir: string | null): TargetState {
  return { workspaceDir, target: workspaceDir ?? "~" };
}

export function reduceWorkspaceDir(state: TargetState, workspaceDir: string | null): TargetState {
  if (workspaceDir !== null && workspaceDir !== state.workspaceDir) {
    return { workspaceDir, target: workspaceDir };
  }
  return { ...state, workspaceDir };
}

export function setManualTarget(state: TargetState, target: string): TargetState {
  return { ...state, target };
}
