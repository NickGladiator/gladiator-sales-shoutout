const GIPHY_API_KEY = process.env.GIPHY_API_KEY;

// Returns a direct GIF URL for a search term, or null if nothing found / the API call fails.
// rating=pg keeps results workplace-appropriate.
export async function fetchGif(searchTerm) {
  if (!GIPHY_API_KEY) return null;
  try {
    const res = await fetch(
      `https://api.giphy.com/v1/gifs/search?api_key=${GIPHY_API_KEY}&q=${encodeURIComponent(searchTerm)}&limit=15&rating=pg`
    );
    if (!res.ok) return null;
    const data = await res.json();
    const gifs = data.data || [];
    if (!gifs.length) return null;
    const pick = gifs[Math.floor(Math.random() * gifs.length)];
    return pick.images?.original?.url || pick.images?.downsized?.url || null;
  } catch {
    return null;
  }
}
