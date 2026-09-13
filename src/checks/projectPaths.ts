/**
 * Paths that are not the project's own files, whatever their name.
 *
 * One definition, shared. Found the hard way twice: ifEditThenTest demanded
 * a test for /private/tmp/.../scratchpad/probe.mjs, and fileLifecycle fired
 * a "CHANGELOG.md is release-only" rule on a scratchpad copy of that file
 * written during a probe and deleted minutes later. Two checkers needed the
 * same exclusion and only one had it, which is exactly how the two copies
 * of TEST_COMMAND would have drifted.
 *
 * Both callers use this to decide whether to accuse someone, so the cost of
 * a miss here is a false FAIL on a throwaway file.
 */
export const NON_PROJECT_PATH =
  /(?:^|\/)(?:tmp|temp|scratch|scratchpad|node_modules|dist|build|out|coverage|\.git|\.next|\.cache|vendor|__pycache__)(?:\/|$)|^\/(?:private\/)?(?:tmp|var)\//i;

/** True when this path is somewhere the project's own rules should govern. */
export function isProjectPath(path: string): boolean {
  return !NON_PROJECT_PATH.test(path);
}
