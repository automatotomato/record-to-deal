export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      counties: {
        Row: {
          county: string
          court_records_enabled: boolean
          created_at: string
          enabled: boolean
          id: string
          last_run_at: string | null
          notes: string | null
          parser_key: string
          priority: string
          source_url: string | null
          state: string
          updated_at: string
        }
        Insert: {
          county: string
          court_records_enabled?: boolean
          created_at?: string
          enabled?: boolean
          id?: string
          last_run_at?: string | null
          notes?: string | null
          parser_key: string
          priority?: string
          source_url?: string | null
          state: string
          updated_at?: string
        }
        Update: {
          county?: string
          court_records_enabled?: boolean
          created_at?: string
          enabled?: boolean
          id?: string
          last_run_at?: string | null
          notes?: string | null
          parser_key?: string
          priority?: string
          source_url?: string | null
          state?: string
          updated_at?: string
        }
        Relationships: []
      }
      lead_activities: {
        Row: {
          actor_id: string | null
          created_at: string
          id: string
          kind: string
          lead_id: string
          payload: Json | null
          summary: string | null
        }
        Insert: {
          actor_id?: string | null
          created_at?: string
          id?: string
          kind: string
          lead_id: string
          payload?: Json | null
          summary?: string | null
        }
        Update: {
          actor_id?: string | null
          created_at?: string
          id?: string
          kind?: string
          lead_id?: string
          payload?: Json | null
          summary?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "lead_activities_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
        ]
      }
      lead_touchpoints: {
        Row: {
          body: string | null
          created_at: string
          direction: string
          id: string
          kind: string
          lead_id: string
          metadata: Json
          occurred_at: string
          outcome: string | null
          subject: string | null
          user_id: string | null
        }
        Insert: {
          body?: string | null
          created_at?: string
          direction?: string
          id?: string
          kind: string
          lead_id: string
          metadata?: Json
          occurred_at?: string
          outcome?: string | null
          subject?: string | null
          user_id?: string | null
        }
        Update: {
          body?: string | null
          created_at?: string
          direction?: string
          id?: string
          kind?: string
          lead_id?: string
          metadata?: Json
          occurred_at?: string
          outcome?: string | null
          subject?: string | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "lead_touchpoints_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
        ]
      }
      leads: {
        Row: {
          assessed_value: number | null
          assigned_to: string | null
          capital_gains_estimate: number | null
          company_website: string | null
          contact_completeness: number | null
          contact_email: string | null
          contact_linkedin: string | null
          contact_phone: string | null
          county: string
          county_id: string | null
          created_at: string
          data_sources: string[] | null
          days_since_sale: number | null
          decision_maker_email: string | null
          decision_maker_linkedin: string | null
          decision_maker_name: string | null
          decision_maker_phone: string | null
          decision_maker_role: string | null
          deed_date: string | null
          depreciation_recapture_est: number | null
          discovery_confidence_by_field: Json
          discovery_status: string
          enrichment_confidence: number
          enrichment_payload: Json
          entity_registry_url: string | null
          fed_capital_gains_estimate: number | null
          has_contact: boolean
          has_outreach_contact: boolean
          id: string
          is_urgent: boolean
          last_contacted_at: string | null
          last_touchpoint_at: string | null
          last_touchpoint_kind: string | null
          list_date: string | null
          list_price: number | null
          lv_property_recommendation: string | null
          mailing_address: string | null
          motivation_type: string | null
          next_action: string | null
          next_action_at: string | null
          notes: string | null
          owner_name: string | null
          owner_type: Database["public"]["Enums"]["owner_type"] | null
          ownership_years: number | null
          parcel_number: string | null
          personality_type: string | null
          pipeline_stage: string
          pitch_angle: string | null
          preferred_channel: string | null
          profiler_summary: string | null
          property_address: string | null
          property_city: string | null
          property_type: Database["public"]["Enums"]["property_type"] | null
          property_zip: string | null
          qualification_reason: string | null
          qualifier_notes: string | null
          related_entities: Json
          sale_date: string | null
          sale_price: number | null
          score: number | null
          score_breakdown: Json | null
          scout_confidence: number | null
          smarty_key: string | null
          source_record_url: string | null
          state: string
          state_capital_gains_estimate: number | null
          state_tax_rate: number | null
          status: Database["public"]["Enums"]["lead_status"]
          tier: Database["public"]["Enums"]["lead_tier"]
          total_tax_exposure: number | null
          trigger_event: Database["public"]["Enums"]["trigger_event"] | null
          updated_at: string
          wealth_signals: Json | null
        }
        Insert: {
          assessed_value?: number | null
          assigned_to?: string | null
          capital_gains_estimate?: number | null
          company_website?: string | null
          contact_completeness?: number | null
          contact_email?: string | null
          contact_linkedin?: string | null
          contact_phone?: string | null
          county: string
          county_id?: string | null
          created_at?: string
          data_sources?: string[] | null
          days_since_sale?: number | null
          decision_maker_email?: string | null
          decision_maker_linkedin?: string | null
          decision_maker_name?: string | null
          decision_maker_phone?: string | null
          decision_maker_role?: string | null
          deed_date?: string | null
          depreciation_recapture_est?: number | null
          discovery_confidence_by_field?: Json
          discovery_status?: string
          enrichment_confidence?: number
          enrichment_payload?: Json
          entity_registry_url?: string | null
          fed_capital_gains_estimate?: number | null
          has_contact?: boolean
          has_outreach_contact?: boolean
          id?: string
          is_urgent?: boolean
          last_contacted_at?: string | null
          last_touchpoint_at?: string | null
          last_touchpoint_kind?: string | null
          list_date?: string | null
          list_price?: number | null
          lv_property_recommendation?: string | null
          mailing_address?: string | null
          motivation_type?: string | null
          next_action?: string | null
          next_action_at?: string | null
          notes?: string | null
          owner_name?: string | null
          owner_type?: Database["public"]["Enums"]["owner_type"] | null
          ownership_years?: number | null
          parcel_number?: string | null
          personality_type?: string | null
          pipeline_stage?: string
          pitch_angle?: string | null
          preferred_channel?: string | null
          profiler_summary?: string | null
          property_address?: string | null
          property_city?: string | null
          property_type?: Database["public"]["Enums"]["property_type"] | null
          property_zip?: string | null
          qualification_reason?: string | null
          qualifier_notes?: string | null
          related_entities?: Json
          sale_date?: string | null
          sale_price?: number | null
          score?: number | null
          score_breakdown?: Json | null
          scout_confidence?: number | null
          smarty_key?: string | null
          source_record_url?: string | null
          state: string
          state_capital_gains_estimate?: number | null
          state_tax_rate?: number | null
          status?: Database["public"]["Enums"]["lead_status"]
          tier?: Database["public"]["Enums"]["lead_tier"]
          total_tax_exposure?: number | null
          trigger_event?: Database["public"]["Enums"]["trigger_event"] | null
          updated_at?: string
          wealth_signals?: Json | null
        }
        Update: {
          assessed_value?: number | null
          assigned_to?: string | null
          capital_gains_estimate?: number | null
          company_website?: string | null
          contact_completeness?: number | null
          contact_email?: string | null
          contact_linkedin?: string | null
          contact_phone?: string | null
          county?: string
          county_id?: string | null
          created_at?: string
          data_sources?: string[] | null
          days_since_sale?: number | null
          decision_maker_email?: string | null
          decision_maker_linkedin?: string | null
          decision_maker_name?: string | null
          decision_maker_phone?: string | null
          decision_maker_role?: string | null
          deed_date?: string | null
          depreciation_recapture_est?: number | null
          discovery_confidence_by_field?: Json
          discovery_status?: string
          enrichment_confidence?: number
          enrichment_payload?: Json
          entity_registry_url?: string | null
          fed_capital_gains_estimate?: number | null
          has_contact?: boolean
          has_outreach_contact?: boolean
          id?: string
          is_urgent?: boolean
          last_contacted_at?: string | null
          last_touchpoint_at?: string | null
          last_touchpoint_kind?: string | null
          list_date?: string | null
          list_price?: number | null
          lv_property_recommendation?: string | null
          mailing_address?: string | null
          motivation_type?: string | null
          next_action?: string | null
          next_action_at?: string | null
          notes?: string | null
          owner_name?: string | null
          owner_type?: Database["public"]["Enums"]["owner_type"] | null
          ownership_years?: number | null
          parcel_number?: string | null
          personality_type?: string | null
          pipeline_stage?: string
          pitch_angle?: string | null
          preferred_channel?: string | null
          profiler_summary?: string | null
          property_address?: string | null
          property_city?: string | null
          property_type?: Database["public"]["Enums"]["property_type"] | null
          property_zip?: string | null
          qualification_reason?: string | null
          qualifier_notes?: string | null
          related_entities?: Json
          sale_date?: string | null
          sale_price?: number | null
          score?: number | null
          score_breakdown?: Json | null
          scout_confidence?: number | null
          smarty_key?: string | null
          source_record_url?: string | null
          state?: string
          state_capital_gains_estimate?: number | null
          state_tax_rate?: number | null
          status?: Database["public"]["Enums"]["lead_status"]
          tier?: Database["public"]["Enums"]["lead_tier"]
          total_tax_exposure?: number | null
          trigger_event?: Database["public"]["Enums"]["trigger_event"] | null
          updated_at?: string
          wealth_signals?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "leads_county_id_fkey"
            columns: ["county_id"]
            isOneToOne: false
            referencedRelation: "counties"
            referencedColumns: ["id"]
          },
        ]
      }
      outreach_emails: {
        Row: {
          body: string
          created_at: string
          drafted_by: string | null
          error: string | null
          gmail_message_id: string | null
          id: string
          lead_id: string
          sent_at: string | null
          sent_by: string | null
          status: string
          subject: string
          to_email: string | null
          updated_at: string
        }
        Insert: {
          body: string
          created_at?: string
          drafted_by?: string | null
          error?: string | null
          gmail_message_id?: string | null
          id?: string
          lead_id: string
          sent_at?: string | null
          sent_by?: string | null
          status?: string
          subject: string
          to_email?: string | null
          updated_at?: string
        }
        Update: {
          body?: string
          created_at?: string
          drafted_by?: string | null
          error?: string | null
          gmail_message_id?: string | null
          id?: string
          lead_id?: string
          sent_at?: string | null
          sent_by?: string | null
          status?: string
          subject?: string
          to_email?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "outreach_emails_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
        ]
      }
      pipeline_jobs: {
        Row: {
          attempts: number
          county_id: string | null
          created_at: string
          finished_at: string | null
          id: string
          kind: string
          last_error: string | null
          lead_id: string | null
          locked_at: string | null
          locked_by: string | null
          max_attempts: number
          payload: Json
          priority: number
          result: Json | null
          run_after: string
          status: string
        }
        Insert: {
          attempts?: number
          county_id?: string | null
          created_at?: string
          finished_at?: string | null
          id?: string
          kind: string
          last_error?: string | null
          lead_id?: string | null
          locked_at?: string | null
          locked_by?: string | null
          max_attempts?: number
          payload?: Json
          priority?: number
          result?: Json | null
          run_after?: string
          status?: string
        }
        Update: {
          attempts?: number
          county_id?: string | null
          created_at?: string
          finished_at?: string | null
          id?: string
          kind?: string
          last_error?: string | null
          lead_id?: string | null
          locked_at?: string | null
          locked_by?: string | null
          max_attempts?: number
          payload?: Json
          priority?: number
          result?: Json | null
          run_after?: string
          status?: string
        }
        Relationships: []
      }
      profiles: {
        Row: {
          created_at: string
          display_name: string | null
          email: string | null
          id: string
        }
        Insert: {
          created_at?: string
          display_name?: string | null
          email?: string | null
          id: string
        }
        Update: {
          created_at?: string
          display_name?: string | null
          email?: string | null
          id?: string
        }
        Relationships: []
      }
      scout_runs: {
        Row: {
          counties_scanned: number | null
          errors: Json | null
          finished_at: string | null
          id: string
          leads_found: number | null
          leads_profiled: number | null
          leads_qualified: number | null
          leads_updated: number
          started_at: string
          status: Database["public"]["Enums"]["scout_run_status"]
          trigger_kind: string
          triggered_by: string | null
        }
        Insert: {
          counties_scanned?: number | null
          errors?: Json | null
          finished_at?: string | null
          id?: string
          leads_found?: number | null
          leads_profiled?: number | null
          leads_qualified?: number | null
          leads_updated?: number
          started_at?: string
          status?: Database["public"]["Enums"]["scout_run_status"]
          trigger_kind?: string
          triggered_by?: string | null
        }
        Update: {
          counties_scanned?: number | null
          errors?: Json | null
          finished_at?: string | null
          id?: string
          leads_found?: number | null
          leads_profiled?: number | null
          leads_qualified?: number | null
          leads_updated?: number
          started_at?: string
          status?: Database["public"]["Enums"]["scout_run_status"]
          trigger_kind?: string
          triggered_by?: string | null
        }
        Relationships: []
      }
      state_tax_rates: {
        Row: {
          is_high_tax: boolean
          ltcg_rate: number
          notes: string | null
          state: string
          state_name: string
          surcharge: number
          updated_at: string
        }
        Insert: {
          is_high_tax?: boolean
          ltcg_rate?: number
          notes?: string | null
          state: string
          state_name: string
          surcharge?: number
          updated_at?: string
        }
        Update: {
          is_high_tax?: boolean
          ltcg_rate?: number
          notes?: string | null
          state?: string
          state_name?: string
          surcharge?: number
          updated_at?: string
        }
        Relationships: []
      }
      user_roles: {
        Row: {
          created_at: string
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      claim_jobs: {
        Args: { p_kind: string; p_limit: number; p_lock_id: string }
        Returns: {
          attempts: number
          county_id: string | null
          created_at: string
          finished_at: string | null
          id: string
          kind: string
          last_error: string | null
          lead_id: string | null
          locked_at: string | null
          locked_by: string | null
          max_attempts: number
          payload: Json
          priority: number
          result: Json | null
          run_after: string
          status: string
        }[]
        SetofOptions: {
          from: "*"
          to: "pipeline_jobs"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
    }
    Enums: {
      app_role: "admin" | "agent"
      lead_status:
        | "new"
        | "reviewing"
        | "contacted"
        | "replied"
        | "meeting"
        | "won"
        | "dead"
      lead_tier:
        | "URGENT"
        | "HOT"
        | "WARM"
        | "COLD"
        | "DISQUALIFIED"
        | "UNSCORED"
        | "CRITICAL"
        | "ACTIVE"
        | "FOLLOW_UP"
        | "EXPIRED"
      owner_type:
        | "Individual"
        | "Joint"
        | "LLC"
        | "Trust"
        | "Corporation"
        | "Estate"
        | "Unknown"
      property_type:
        | "SFR"
        | "Multifamily"
        | "Commercial"
        | "Land"
        | "Mixed"
        | "Unknown"
      scout_run_status: "running" | "success" | "partial" | "failed"
      trigger_event:
        | "sale_recorded"
        | "pending_sale"
        | "listing_aged"
        | "commercial_listing"
        | "probate"
        | "llc_dissolution"
        | "divorce"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      app_role: ["admin", "agent"],
      lead_status: [
        "new",
        "reviewing",
        "contacted",
        "replied",
        "meeting",
        "won",
        "dead",
      ],
      lead_tier: [
        "URGENT",
        "HOT",
        "WARM",
        "COLD",
        "DISQUALIFIED",
        "UNSCORED",
        "CRITICAL",
        "ACTIVE",
        "FOLLOW_UP",
        "EXPIRED",
      ],
      owner_type: [
        "Individual",
        "Joint",
        "LLC",
        "Trust",
        "Corporation",
        "Estate",
        "Unknown",
      ],
      property_type: [
        "SFR",
        "Multifamily",
        "Commercial",
        "Land",
        "Mixed",
        "Unknown",
      ],
      scout_run_status: ["running", "success", "partial", "failed"],
      trigger_event: [
        "sale_recorded",
        "pending_sale",
        "listing_aged",
        "commercial_listing",
        "probate",
        "llc_dissolution",
        "divorce",
      ],
    },
  },
} as const
