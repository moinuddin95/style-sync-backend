import { serve } from "serve";
import {
  GoogleGenAI,
  GenerateContentResponse,
  GenerateVideosResponse,
  GenerateVideosOperation,
} from "@google/genai";
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
// /**
//  * Extracts and validates the clothing_id and user_image_id from the request body.
//  * @param _req The incoming request object.
//  * @returns An object containing the clothing_id and user_image_id.
//  * @throws An error if either clothing_id or user_image_id is missing.
//  */
// const getBodyParam = async (_req: Request) => {
//   const { clothing_id, user_image_id, referer_url } = await _req.json();
//   if (!clothing_id || !user_image_id || !referer_url) {
//     console.error(
//       "[validate] Missing clothing_id, user_image_id, or referer_url in request body"
//     );
//     throw new Error("Missing clothing_id, user_image_id, or referer_url in request body");
//   }
//   console.log(
//     `[validate] Received body params clothing_id=${clothing_id}, user_image_id=${user_image_id}, referer_url=${referer_url}`
//   );
//   return { clothing_id, user_image_id, referer_url };
// };
const getBodyParam = async (_req: Request) => {
  const { signed_url } = await _req.json();
  if (!signed_url) {
    console.error("[validate] Missing signed_url in request body");
    throw new Error("Missing signed_url in request body");
  }
  console.log(`[validate] Received body params signed_url=${signed_url}`);
  return { signed_url };
};
/** Fetches the user_id associated with a given user_image_id from the database.
 * @param supabase The Supabase client instance.
 * @param user_image_id The ID of the user image.
 * @returns The user_id associated with the user_image_id.
 * @throws An error if the user_id cannot be fetched.
 */
const getUserIdFromUserImageId = async (
  supabase: SupabaseClient,
  user_image_id: string
): Promise<string> => {
  const { data, error } = await supabase
    .from("user_images")
    .select("user_id")
    .eq("id", user_image_id)
    .single();
  if (error || !data) {
    console.error(
      `[db] Error fetching user_id for user_image_id=${user_image_id}:`,
      error || "No data"
    );
    throw new Error(
      `Error fetching user_id for user_image_id ${user_image_id}: ${
        JSON.stringify(error) || "No data"
      }`
    );
  }
  console.log(
    `[db] Fetched user_id=${data.user_id} for user_image_id=${user_image_id}`
  );
  return data.user_id;
};
/**
 * Fetches an image from Supabase Storage.
 *
 * @param supabase - The Supabase client instance.
 * @param bucket - The name of the storage bucket.
 * @param path - The path to the image file within the bucket.
 * @returns The image data as a Uint8Array.
 * @throws Will throw an error if the image cannot be fetched.
 */
const fetchImageFromStorage = async (
  supabase: SupabaseClient,
  bucket: string,
  path: string
) => {
  const { data: imageData, error: imageError } = await supabase.storage
    .from(bucket)
    .download(path);
  if (imageError || !imageData) {
    console.error(
      `[storage] Error fetching image bucket=${bucket} path=${path}:`,
      imageError || "No data"
    );
    throw new Error(
      `Error fetching image from storage in bucket ${bucket} and path ${path}: ${
        JSON.stringify(imageError) || "No data"
      }`
    );
  }
  console.log(
    `[storage] Downloaded image bytes from bucket=${bucket} path=${path}`
  );
  return new Uint8Array(await imageData.arrayBuffer());
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
    imageBytes: base64Data,
    mimeType: mimeType,
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
/** Fetches the clothing image URL from the database.
 * @param clothing_id The ID of the clothing item.
 * @returns The URL of the clothing image.
 * @throws An error if the clothing image URL cannot be fetched.
 */
const fetchClothingImageData = async (
  clothing_id: string,
  supabase: SupabaseClient
) => {
  const { data, error } = await supabase
    .from("clothing_items")
    .select("image_url, title")
    .eq("id", clothing_id)
    .single();
  if (error || !data) {
    console.error(
      `[db] Error fetching clothing image URL for clothing_id=${clothing_id}:`,
      error || "No data"
    );
    throw new Error(
      `Error fetching clothing image URL for clothing_id ${clothing_id}: ${
        JSON.stringify(error) || "No data"
      }`
    );
  }
  console.log(`[db] Fetched clothing image URL for clothing_id=${clothing_id}`);
  return { image_url: data.image_url, title: data.title };
};
/**
 * Fetches an image from a public URL and returns Gemini inlineData;
 * @param imageUrl The URL of the image to fetch.
 * @param mimeType The MIME type of the image (optional).
 * @returns The Gemini inlineData object containing the image data.
 */
const imageUrlToGeminiInlineData = async (
  imageUrl: string,
  refererUrl: string,
  mimeType?: string
) => {
  const res = await fetch(imageUrl, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/58.0.3029.110 Safari/537.3",
      Accept: "image/webp,image/apng,image/*,*/*;q=0.8",
      Referer: refererUrl,
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
/** Fetches the user image URL from the database.
 * @param supabase The Supabase client instance.
 * @param user_id The ID of the user.
 * @returns The URL of the user's image.
 * @throws An error if the user image URL cannot be fetched.
 */
const fetchUserImageData = async (
  supabase: SupabaseClient,
  user_id: string
) => {
  // NOTE: Query shape may be refactored depending on future schema changes.
  const { data: userData, error: userError } = await supabase
    .from("user_images")
    .select("image_url, mime_type")
    .eq("id", user_id)
    .single();
  if (userError || !userData) {
    console.error(
      `[db] Error fetching user image for user_id=${user_id}:`,
      userError || "No data"
    );
    throw new Error(
      `Error fetching user image URL for user_id ${user_id}: ${
        JSON.stringify(userError) || "No data"
      }`
    );
  }
  console.log(`[db] Fetched user image metadata for user_id=${user_id}`);
  return { userImageUrl: userData.image_url, mimeType: userData.mime_type };
};
// /**
//  * Prompts and Fetches the generated image bytes from the Gemini API.
//  * @param ai The GoogleGenAI instance.
//  * @param userInlineData The inline data for the user image.
//  * @param clothingInlineData The inline data for the clothing image.
//  * @returns The generated image data from the Gemini API.
//  */
// const promptGeminiForImage = async (
//   ai: GoogleGenAI,
//   userInlineData: any,
//   clothingInlineData: any,
//   clothingTitle: string
// ) => {
//   const response: GenerateContentResponse = await ai.models.generateContent({
//     model: "gemini-2.5-flash-image-preview",
//     contents: [
//       {
//         text: `Replace the clothing on the person in Image 1 with the ${clothingTitle} shown in Image 2. Maintain the person’s original body pose, facial expression, hairstyle, and background. Ensure the ${clothingTitle} appears naturally fitted on the person, with correct proportions, realistic textures, and lighting consistent with Image 1. Do not alter the person’s face, body, or environment — only change the apparel to seamlessly match the ${clothingTitle} from Image 2.`,
//       },
//       userInlineData,
//       clothingInlineData,
//     ],
//   });
//   for (const part of response?.candidates?.[0].content?.parts || []) {
//     if (part.inlineData) {
//       const imageData = part.inlineData.data ?? "";
//       // Decode base64 to Uint8Array using Deno APIs
//       const binaryString = atob(imageData);
//       const len = binaryString.length;
//       const bytes = new Uint8Array(len);
//       for (let i = 0; i < len; i++) {
//         bytes[i] = binaryString.charCodeAt(i);
//       }
//       if (!bytes || bytes.length === 0) {
//         console.error("[ai] Empty image data returned from Gemini response");
//         throw new Error("No image data found in Gemini response");
//       }
//       console.log(
//         `[ai] Received generated image bytes, length=${bytes.length}`
//       );
//       return bytes;
//     }
//   }
//   console.error("[ai] No inlineData parts found in Gemini response");
//   throw new Error("No image generated by Gemini API");
// };

const promptGeminiForVideo = async (ai: GoogleGenAI, tryonInlineData: any) => {
  try {
    console.log(
      "[ai:video] Initiating video generation request (model=veo-3.1-generate-preview)"
    );
    let response: GenerateVideosOperation = await ai.models.generateVideos({
      model: "veo-3.1-generate-preview",
      prompt: "generate a video of this model while modeling",
      image: tryonInlineData,
    });
    let attempt = 0;
    while (!response.done) {
      attempt++;
      console.log(
        `[ai:video] Poll attempt #${attempt} - operation still in progress`
      );
      await new Promise((resolve) => setTimeout(resolve, 10000));
      try {
        response = await ai.operations.getVideosOperation({
          operation: response,
        });
        console.log(
          `[ai:video] Poll attempt #${attempt} succeeded (done=${response.done})`
        );
      } catch (pollErr) {
        console.error(
          `[ai:video] Poll attempt #${attempt} failed with error:`,
          pollErr
        );
      }
    }
    console.log("[ai:video] Video generation completed successfully.");
    try {
      const videoResponse = response.response?.generatedVideos?.[0]?.video!;
      console.log("videoResponse:", videoResponse);
      return videoResponse;
    } catch (logErr) {
      console.warn(
        "[ai:video] Failed to extract metadata from response:",
        logErr
      );
    }
  } catch (err) {
    console.error("[ai:video] Initial video generation request failed:", err);
  }
};
/**
 * Inserts or updates the try-on data in the database.
 * if a record exists, increments the tryon_count.
 * if no record exists, creates a new one with tryon_count set to 1.
 * @param supabase The Supabase client instance.
 * @param user_id The ID of the user.
 * @param clothing_id The ID of the clothing item.
 * @param user_image_id The ID of the user image.
 * @returns The image URL for the try-on session.
 */
const insertOrUpdateTryonData = async (
  supabase: SupabaseClient,
  user_id: string,
  clothing_id: string,
  user_image_id: string
) => {
  // 1) Try insert a new record first
  const { data: insertData, error: insertError } = await supabase
    .from("tryon_results")
    .insert({
      user_id,
      clothing_id,
      user_image_id,
      tryon_count: 1,
    })
    .select("id")
    .single();

  if (!insertError && insertData) {
    // Insert succeeded: set image_url and return it
    const newTryonResultId = insertData.id;
    const imageUrl = `${user_id}/${newTryonResultId}.png`;
    const { error: imageUrlError } = await supabase
      .from("tryon_results")
      .update({ image_url: imageUrl })
      .eq("id", newTryonResultId);
    if (imageUrlError) {
      console.error(
        `[db] Error updating image_url for tryon_result_id=${newTryonResultId}:`,
        imageUrlError
      );
      throw new Error(
        `Error updating image_url for tryon_result_id ${newTryonResultId}: ${JSON.stringify(
          imageUrlError
        )}`
      );
    }
    console.log(
      `[db] Inserted tryon_result id=${newTryonResultId} and set image_url=${imageUrl}`
    );
    return { imageUrl };
  }

  if (insertError) {
    console.log(
      `[db] Insert failed (likely conflict), attempting manual increment for user_id=${user_id}, clothing_id=${clothing_id}, user_image_id=${user_image_id}`,
      insertError
    );
  }

  // 2) Select current tryon_count and image_url
  const { data: existing, error: fetchError } = await supabase
    .from("tryon_results")
    .select("id, image_url, tryon_count")
    .eq("user_id", user_id)
    .eq("clothing_id", clothing_id)
    .eq("user_image_id", user_image_id)
    .single();
  if (fetchError || !existing) {
    console.error(
      `[db] Failed to fetch existing tryon_result for increment user_id=${user_id}, clothing_id=${clothing_id}, user_image_id=${user_image_id}:`,
      fetchError || "No data"
    );
    throw new Error(
      `Error fetching existing tryon_result for increment: ${
        JSON.stringify(fetchError) || "No data"
      }`
    );
  }

  // handling tryon_count limit exceeded
  if (existing.tryon_count === 3) {
    console.log(
      "[db] Tryon count limit exceeded for existing record:",
      existing
    );
    return { limitExceeded: true };
  }

  const newCount = (existing.tryon_count ?? 1) + 1;
  const { error: updateError } = await supabase
    .from("tryon_results")
    .update({ tryon_count: newCount })
    .eq("id", existing.id);
  if (updateError) {
    console.error(
      `[db] Error incrementing tryon_count for tryon_result_id=${existing.id} to ${newCount}:`,
      updateError
    );
    throw new Error(
      `Error incrementing tryon_count: ${JSON.stringify(updateError)}`
    );
  }

  console.log(
    `[db] Incremented existing tryon_result id=${existing.id} to tryon_count=${newCount}, returning image_url=${existing.image_url}`
  );
  return { imageUrl: existing.image_url };
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
// serve(async (_req: Request) => {
//   // Handle CORS preflight
//   if (_req.method === "OPTIONS") {
//     console.log("[http] CORS preflight handled");
//     return new Response("OK", { headers: corsHeaders });
//   }
//   if (_req.method !== "POST") {
//     console.error(`[http] Method not allowed: ${_req.method}`);
//     return new Response("Method not allowed", { status: 405 });
//   }
//   try {
//     console.log("[init] Starting try-on request handling");
//     const globalHeaders: Record<string, string> = {};
//     const authHeader = _req.headers.get("Authorization");
//     if (authHeader) globalHeaders["Authorization"] = authHeader;
//     console.log(`[init] Authorization header present=${Boolean(authHeader)}`);

//     const supabase = createClient(
//       getEnvVar("SUPABASE_URL"),
//       getEnvVar("SUPABASE_SERVICE_ROLE_KEY"),
//       {
//         global: {
//           headers: globalHeaders,
//         },
//       }
//     );
//     console.log("[init] Supabase client initialized");
//     // Get and validate request body and user ID
//     const { clothing_id, user_image_id, referer_url } = await getBodyParam(_req);
//     const user_id = await getUserIdFromUserImageId(supabase, user_image_id);
//     console.log(`[flow] Resolved user_id=${user_id} for processing`);

//     // handling the tryon result
//     const { imageUrl, limitExceeded } = await insertOrUpdateTryonData(
//       supabase,
//       user_id,
//       clothing_id,
//       user_image_id
//     );

//     if (limitExceeded) {
//       return new Response(JSON.stringify({ limitExceeded }), {
//       status: 229,
//       headers: { ...corsHeaders, "Content-Type": "application/json" },
//       });
//     }

//     // user image parsing starts here
//     const { userImageUrl, mimeType } = await fetchUserImageData(
//       supabase,
//       user_image_id
//     );
//     console.log(
//       `[flow] User image metadata: url=${userImageUrl}, mime=${
//         mimeType || "unknown"
//       }`
//     );
//     const userImageBytes = await fetchImageFromStorage(
//       supabase,
//       "user_uploads",
//       userImageUrl
//     );
//     const userInlineData = toGeminiInlineData(userImageBytes, mimeType);
//     console.log("[flow] Prepared userInlineData for Gemini");

//     // clothing image parsing starts here
//     const { image_url: clothingImageUrl, title: clothingTitle } = await fetchClothingImageData(clothing_id, supabase);
//     console.log(`[flow] Clothing image URL: ${clothingImageUrl}`);
//     const clothingInlineData = await imageUrlToGeminiInlineData(
//       clothingImageUrl, referer_url
//     );
//     console.log("[flow] Prepared clothingInlineData for Gemini");

//     // Gemini API interaction starts here
//     const API_KEY = getEnvVar("GEMINI_API_KEY");
//     const ai = new GoogleGenAI({
//       apiKey: API_KEY,
//     });
//     console.log("[ai] GoogleGenAI client initialized");
//     const imageBytes = await promptGeminiForImage(
//       ai,
//       userInlineData,
//       clothingInlineData,
//       clothingTitle
//     );
//     console.log(`[ai] Generated try-on image, bytes=${imageBytes.length}`);

//     console.log(`[flow] Upserted tryon record with path=${imageUrl}`);
//     // Upload the generated image to Supabase Storage
//     await uploadImageToStorage(supabase, "tryon_results", imageUrl, imageBytes);
//     console.log("[storage] Uploaded generated image");
//     //todo: look here
//     const signedUrl = await getImageUrl(supabase, "tryon_results", imageUrl);
//     console.log(`[done] Public URL generated: ${signedUrl}`);

//     // respond with the public URL of the generated image
//     return new Response(JSON.stringify({ signedUrl }), {
//       status: 200,
//       headers: { ...corsHeaders, "Content-Type": "application/json" },
//     });
//   } catch (e: unknown) {
//     const message = e instanceof Error ? e.message : "Unexpected error";
//     console.error("[error] Try-on request failed:", e);
//     return new Response(JSON.stringify({ error: message }), {
//       status: 500,
//       headers: { "Content-Type": "application/json" },
//     });
//   }
// });
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
    // get signed url
    const { signed_url } = await getBodyParam(_req);

    // fetch image from supabase storage
    const tryonInlineData = await imageUrlToGeminiInlineData(
      signed_url,
      "",
      "image/png"
    );

    // Gemini API interaction starts here
    const API_KEY = getEnvVar("GEMINI_API_KEY");
    const ai = new GoogleGenAI({
      apiKey: API_KEY,
    });
    console.log("[ai] GoogleGenAI client initialized");
    const videoResponse = await promptGeminiForVideo(ai, tryonInlineData);
    const videoUri = videoResponse?.uri! + "&key=" + API_KEY;

    // start
    // 1. Fetch the video binary
    const fetchRes = await fetch(videoUri);
    if (!fetchRes.ok) {
      return new Response("Failed to fetch video", { status: 500 });
    }

    const arrayBuf = await fetchRes.arrayBuffer();
    const bytes = new Uint8Array(arrayBuf);

    //Todo: update the name here
    const finalFileName = `video-${crypto.randomUUID()}.mp4`;

    // 2. Upload to Supabase Storage
    const { error: uploadError } = await supabase.storage
      .from("videos")
      .upload(finalFileName, bytes, {
        contentType: "video/mp4",
        upsert: true,
      });

    if (uploadError) {
      console.error(uploadError);
      return new Response("Upload failed", { status: 500 });
    }

    // 3. Create signed URL
    const { data, error: signError } = await supabase.storage
      .from("videos")
      .createSignedUrl(finalFileName, 60 * 60); // 1hr expiry

    if (signError) {
      console.error(signError);
      return new Response("Signed URL generation failed", { status: 500 });
    }

    // 4. Return signed URL
    return Response.json({
      signedUrl: data.signedUrl,
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Unexpected error";
    console.error("[error] Try-on request failed:", e);
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
