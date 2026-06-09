// Re-export generic database helpers.
// Users can augment `Database` by generating types with:
//   supanow gen types typescript --project-ref <ref> > types/database.ts
// then importing: import type { Database } from './types/database'

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[]

export interface Database {
  public: {
    Tables: Record<string, any>
    Views: Record<string, any>
    Functions: Record<string, any>
    Enums: Record<string, any>
    CompositeTypes: Record<string, any>
  }
}

export type Tables<
  Schema extends keyof Database = 'public',
  TableName extends keyof Database[Schema]['Tables'] = keyof Database[Schema]['Tables'],
> = Database[Schema]['Tables'][TableName] extends { Row: infer R } ? R : never

export type TablesInsert<
  Schema extends keyof Database = 'public',
  TableName extends keyof Database[Schema]['Tables'] = keyof Database[Schema]['Tables'],
> = Database[Schema]['Tables'][TableName] extends { Insert: infer I } ? I : never

export type TablesUpdate<
  Schema extends keyof Database = 'public',
  TableName extends keyof Database[Schema]['Tables'] = keyof Database[Schema]['Tables'],
> = Database[Schema]['Tables'][TableName] extends { Update: infer U } ? U : never

export type Enums<
  Schema extends keyof Database = 'public',
  EnumName extends keyof Database[Schema]['Enums'] = keyof Database[Schema]['Enums'],
> = Database[Schema]['Enums'][EnumName]
