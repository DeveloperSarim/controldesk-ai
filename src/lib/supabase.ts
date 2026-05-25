import { createClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

// Check if URL is valid syntax
const isValidUrl = (url: string): boolean => {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
};

// Yeh export wapas daal diya hai taake App.tsx ka error khatam ho jaye
export const isSupabaseConfigured = !!(supabaseUrl && isValidUrl(supabaseUrl) && supabaseAnonKey);

if (!isSupabaseConfigured) {
  console.warn(
    "Supabase client initialization warning: VITE_SUPABASE_URL must be a valid URL, and VITE_SUPABASE_ANON_KEY must be defined. Check your .env file."
  );
}

// Client initialize karein bina placeholders ke
export const supabase = createClient(
  isSupabaseConfigured ? (supabaseUrl as string) : "https://invalid-url.supabase.co",
  supabaseAnonKey || "invalid-key",
  {
    realtime: {
      headers: {
        apikey: supabaseAnonKey || "invalid-key",
      },
    },
  }
);