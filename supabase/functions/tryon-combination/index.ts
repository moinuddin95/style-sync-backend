import { serve } from "serve";
import { GoogleGenAI, GenerateContentResponse } from "@google/genai";
import { createClient, SupabaseClient } from "@supabase/supabase-js";

// CORS configuration
// NOTE: Consider restricting origins and headers before production deployment.
const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Max-Age": "86400",
};

/**
 * Helper to ensure required env vars exist
 * @param name
 * @returns
 */
const getEnvVar = (name: string): string => {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  console.log(`[env] Loaded ${name}`);
  return value;
};

const getBodyParam = async (_req: Request) => {
  const { image1_url, image1_title, image2_url, image2_title } =
    await _req.json();
  if (!image1_url || !image2_url || !image1_title || !image2_title) {
    console.error(
      "[validate] Missing image1_url, image1_title, image2_url, or image2_title in request body"
    );
    throw new Error(
      "Missing image1_url, image1_title, image2_url, or image2_title in request body"
    );
  }
  console.log(
    `[validate] Received body params image1_url=${image1_url}, image1_title=${image1_title}, image2_url=${image2_url}, image2_title=${image2_title}`
  );
  return { image1_url, image1_title, image2_url, image2_title };
};
/** Converts a Uint8Array to a Base64 encoded string.
 * @param bytes The Uint8Array to convert.
 * @returns The Base64 encoded string.
 */
const convertUint8ArrayToBase64 = (bytes: Uint8Array) => {
  let binary = "";
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
};
/** Converts image bytes and mime type to Gemini inline data format.
 * @param imageBytes The image data as a Uint8Array.
 * @param mimeType The MIME type of the image.
 * @returns The Gemini inline data object.
 */
const toGeminiInlineData = (imageBytes: Uint8Array, mimeType: string) => {
  const base64Data = convertUint8ArrayToBase64(imageBytes);
  return {
    inlineData: {
      data: base64Data,
      mimeType: mimeType,
    },
  };
};
/**
 * Infers a MIME type from a URL's file extension.
 * @param url The URL to infer the MIME type from.
 * @returns The inferred MIME type, or null if it cannot be determined.
 */
const inferMimeTypeFromUrl = (url: string): string | null => {
  const clean = url.split("?")[0].split("#")[0];
  const ext = clean.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    case "bmp":
      return "image/bmp";
    case "tif":
    case "tiff":
      return "image/tiff";
    case "heic":
      return "image/heic";
    default:
      return null;
  }
};
/**
 * Fetches an image from a public URL and returns Gemini inlineData;
 * @param imageUrl The URL of the image to fetch.
 * @param mimeType The MIME type of the image (optional).
 * @returns The Gemini inlineData object containing the image data.
 */
const imageUrlToGeminiInlineData = async (
  imageUrl: string,
  mimeType?: string
) => {
  const res = await fetch(imageUrl, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/58.0.3029.110 Safari/537.3",
      Accept: "image/webp,image/apng,image/*,*/*;q=0.8",
    },
  });
  if (!res.ok) {
    console.error(
      `[net] Failed to fetch image from URL=${imageUrl}, status=${res.status}`
    );
    throw new Error(
      `Failed to fetch image from URL: ${imageUrl} (status ${res.status})`
    );
  }
  const contentType = res.headers.get("content-type") || undefined;
  const resolvedMime =
    mimeType || contentType || inferMimeTypeFromUrl(imageUrl);
  if (!resolvedMime) {
    console.error(`[mime] Unable to determine MIME type for URL=${imageUrl}`);
    throw new Error(
      `Unable to determine MIME type for image at URL: ${imageUrl}. Provide mimeType explicitly or ensure the URL has a known extension.`
    );
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  console.log(
    `[net] Fetched image from URL=${imageUrl}, bytes=${bytes.length}`
  );
  return toGeminiInlineData(bytes, resolvedMime);
};
/**
 * Prompts and Fetches the generated image bytes from the Gemini API.
 * @param ai The GoogleGenAI instance.
 * @param userInlineData The inline data for the user image.
 * @param clothingInlineData The inline data for the clothing image.
 * @returns The generated image data from the Gemini API.
 */
const promptGemini = async (
  ai: GoogleGenAI,
  image1InlineData: any,
  image1Title: string,
  image2InlineData: any,
  image2Title: string
) => {
  const response: GenerateContentResponse = await ai.models.generateContent({
    model: "gemini-2.5-flash-image-preview",
    contents: [
      {
        text: `Replace the clothing on the person in Image 1 with the ${image2Title} shown in Image 2. Maintain the person’s original body pose, facial expression, hairstyle, and background. Ensure the ${image2Title} appears naturally fitted on the person, with correct proportions, realistic textures, and lighting consistent with Image 1. Do not alter the person’s face, body, or environment as some of the apparal is not supposed to be replaces like ${image1Title} — only change the apparel to seamlessly match the ${image2Title} from Image 2.`,
      },
      image1InlineData,
      image2InlineData,
    ],
  });
  console.log("[ai] Gemini generateContent request succeeded (promptGemini)");
  for (const part of response?.candidates?.[0].content?.parts || []) {
    if (part.inlineData) {
      const imageData = part.inlineData.data ?? "";
      // Decode base64 to Uint8Array using Deno APIs
      const binaryString = atob(imageData);
      const len = binaryString.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      if (!bytes || bytes.length === 0) {
        console.error("[ai] Empty image data returned from Gemini response");
        console.log("[ai:fail] Decoding inlineData produced empty bytes");
        throw new Error("No image data found in Gemini response");
      }
      console.log(
        `[ai] Received generated image bytes, length=${bytes.length}`
      );
      console.log("[ai] Successfully decoded and validated inlineData bytes");
      return bytes;
    }
  }
  console.error("[ai] No inlineData parts found in Gemini response");
  console.log("[ai:fail] Gemini response lacked inlineData parts");
  throw new Error("No image generated by Gemini API");
};
/**
 * Uploads an image to Supabase Storage.
 * @param supabase The Supabase client instance.
 * @param bucket The name of the storage bucket.
 * @param imagePath The path to the image file in the bucket.
 * @param imageBytes The image data as a byte array.
 * @param mimeType The MIME type of the image (optional).
 */
const uploadImageToStorage = async (
  supabase: SupabaseClient,
  bucket: string,
  imagePath: string,
  imageBytes: Uint8Array,
  mimeType?: string
) => {
  const { error } = await supabase.storage
    .from(bucket)
    .upload(imagePath, imageBytes, {
      contentType: mimeType ?? "image/png",
      upsert: true,
    });
  if (error) {
    console.error(
      `[storage] Error uploading image to bucket=${bucket} path=${imagePath}:`,
      error
    );
    throw new Error(
      `Error uploading image to storage at ${imagePath}: ${JSON.stringify(
        error
      )}`
    );
  }
  console.log(`[storage] Uploaded image to bucket=${bucket} path=${imagePath}`);
};
/** Gets the signed URL of a file in Supabase Storage with expiration in 1 year.
 * @param supabase The Supabase client instance.
 * @param bucket The name of the storage bucket.
 * @param path The path to the file in the bucket.
 * @returns The signed URL of the file.
 */
const getImageUrl = async (
  supabase: SupabaseClient,
  bucket: string,
  path: string
) => {
  const { data, error } = await supabase.storage
    .from(bucket)
    .createSignedUrl(path, 60 * 60 * 24 * 365); // 1 year
  if (error || !data) {
    console.error(
      `[storage] Error generating public URL for bucket=${bucket} path=${path}:`,
      error || "No data"
    );
    throw new Error(
      `Error generating public URL for bucket ${bucket} and path ${path}: ${
        JSON.stringify(error) || "No data"
      }`
    );
  }
  console.log(
    `[storage] Generated public URL for bucket=${bucket} path=${path}`
  );
  return data.signedUrl;
};

serve(async (_req: Request) => {
  // Handle CORS preflight
  if (_req.method === "OPTIONS") {
    console.log("[http] CORS preflight handled");
    return new Response("OK", { headers: corsHeaders });
  }
  if (_req.method !== "POST") {
    console.error(`[http] Method not allowed: ${_req.method}`);
    return new Response("Method not allowed", { status: 405 });
  }
  try {
    console.log("[init] Starting try-on request handling");
    const globalHeaders: Record<string, string> = {};
    const authHeader = _req.headers.get("Authorization");
    if (authHeader) globalHeaders["Authorization"] = authHeader;
    console.log(`[init] Authorization header present=${Boolean(authHeader)}`);

    const supabase = createClient(
      getEnvVar("SUPABASE_URL"),
      getEnvVar("SUPABASE_SERVICE_ROLE_KEY"),
      {
        global: {
          headers: globalHeaders,
        },
      }
    );
    console.log("[init] Supabase client initialized");
    // Get and validate request body and user ID
    const { image1_url, image1_title, image2_url, image2_title } =
      await getBodyParam(_req);
    console.log("[flow] Request body validated successfully");

    const image1InlineData = await imageUrlToGeminiInlineData(
      image1_url,
      "image/png"
    );
    console.log("[flow] Fetched & converted image1 to inlineData successfully");
    const image2InlineData = await imageUrlToGeminiInlineData(
      image2_url,
      "image/png"
    );
    console.log("[flow] Fetched & converted image2 to inlineData successfully");

    // Gemini API interaction starts here
    const API_KEY = getEnvVar("GEMINI_API_KEY");
    const ai = new GoogleGenAI({
      apiKey: API_KEY,
    });
    console.log("[ai] GoogleGenAI client initialized");
    const imageBytes = await promptGemini(
      ai,
      image1InlineData,
      image1_title,
      image2InlineData,
      image2_title
    );
    console.log("[flow] promptGemini completed successfully");
    // Upload the generated image to Supabase Storage
    await uploadImageToStorage(
      supabase,
      "tryon_combination_results",
      `${image1_title}_${image2_title}`,
      imageBytes
    );
    console.log("[storage] Uploaded generated image");
    console.log("[flow] Image upload step succeeded");
    const signedUrl = await getImageUrl(
      supabase,
      "tryon_combination_results",
      `${image1_title}_${image2_title}`
    );
    console.log(`[done] Public URL generated: ${signedUrl}`);
    console.log("[flow] Signed URL generation succeeded");

    // respond with the public URL of the generated image
    return new Response(JSON.stringify({ signedUrl }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Unexpected error";
    console.error("[error] Try-on request failed:", e);
    console.log(
      `[flow:fail] Request handling failed with message='${message}'`
    );
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
