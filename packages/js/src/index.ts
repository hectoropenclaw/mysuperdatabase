export {
  createClient,
  SupabaseClient,
  AuthError,
  AuthApiError,
  AuthRetryableFetchError,
  AuthSessionMissingError,
  AuthInvalidCredentialsError,
  PostgrestError,
  StorageError,
  StorageApiError,
  StorageUnknownError,
  FunctionsError,
  FunctionsHttpError,
  FunctionsRelayError,
  FunctionsFetchError,
  RealtimeChannel,
  RealtimeClient,
  REALTIME_SUBSCRIBE_STATES,
  REALTIME_PRESENCE_LISTEN_EVENTS,
  REALTIME_POSTGRES_CHANGES_LISTEN_EVENT,
  type SupabaseClientOptions,
  type Session,
  type User,
  type AuthChangeEvent,
  type Provider,
  type SignInWithPasswordCredentials,
  type SignUpWithPasswordCredentials,
  type RealtimeChannelOptions,
  type RealtimePostgresChangesPayload,
} from '@supabase/supabase-js'

export type { Database, Tables, TablesInsert, TablesUpdate, Enums } from './types'

/**
 * Creates a supanow client.
 *
 * @param projectRef  - Your project reference (e.g. "abc123xyz")
 * @param anonKey     - Your project's anon key
 * @param options     - Optional client configuration
 *
 * @example
 * ```ts
 * import { createMysuperdatabaseClient } from '@supanow/js'
 *
 * const db = createMysuperdatabaseClient('my-project-ref', 'my-anon-key')
 * const { data, error } = await db.from('users').select('*')
 * ```
 */
export function createMysuperdatabaseClient<
  Database = any,
  SchemaName extends string & keyof Database = 'public' extends keyof Database ? 'public' : string & keyof Database,
>(
  projectRef: string,
  anonKey: string,
  options?: Parameters<typeof import('@supabase/supabase-js').createClient>[2]
) {
  const { createClient } = require('@supabase/supabase-js')
  const url = `https://${projectRef}.db.hconsulting.app`
  return createClient<Database, SchemaName>(url, anonKey, options)
}
