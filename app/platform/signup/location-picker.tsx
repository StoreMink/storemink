"use client";

// ---------------------------------------------------------------------------
// Business-location picker for the signup wizard.
//
// TWO RULES, in this order:
//
//  1. IT MUST WORK WITHOUT A MAP. Location is a REQUIRED step, so the map can
//     never be load-bearing: a missing/rejected API key, a blocked script, or
//     an offline merchant must still be able to type a complete address and
//     finish signing up. Everything Google-shaped here is progressive
//     enhancement layered on top of a plain form that already works.
//
//  2. DEVICE LOCATION DOES NOT DEPEND ON THE MAP. Browser geolocation needs
//     permission but no vendor key. Street/PIN suggestions use the configured
//     Google geocoder; a keyless locality lookup keeps the button useful when
//     the map is unavailable. Every suggestion remains editable.
//
// The Google Maps JS API is injected by hand rather than via a package: it's a
// single <script> with a callback, and the repo's convention is to skip an SDK
// where a few lines do the same job (lib/payments/razorpay.ts does the same).
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useRef, useState } from "react";
import { LocateFixed, Loader2, MapPin } from "lucide-react";

const MAPS_KEY = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ?? "";

/** Where the pin starts when we have nothing better: centre of India. */
const FALLBACK_CENTRE = { lat: 20.5937, lng: 78.9629 };

export type { PickedLocation } from "./location-address";
import {
  googleAddress,
  locationNotice,
  type PickedLocation,
  type GoogleAddressResult,
} from "./location-address";

interface ClientGeocodeResult {
  city?: string;
  locality?: string;
  principalSubdivision?: string;
  countryCode?: string;
  countryName?: string;
  postcode?: string;
}

/**
 * City-level, keyless reverse geocoding for coordinates the browser just
 * captured with permission. This deliberately runs in that same browser — the
 * provider's free client endpoint requires it, and it keeps the location
 * button useful when the optional Google map key is absent.
 */
async function describeCurrentLocation(
  lat: number,
  lng: number,
): Promise<
  Pick<
    PickedLocation,
    "address" | "addressLine1" | "city" | "state" | "postalCode" | "countryCode"
  >
> {
  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lng),
    localityLanguage: "en",
  });
  const response = await fetch(
    `https://api.bigdatacloud.net/data/reverse-geocode-client?${params}`,
    { signal: AbortSignal.timeout(8000) },
  );
  if (!response.ok) throw new Error("reverse geocoding failed");
  const result = (await response.json()) as ClientGeocodeResult;
  const city =
    result.city || result.locality || result.principalSubdivision || "";
  const address = [city, result.principalSubdivision, result.countryName]
    .filter((part, index, all) => part && all.indexOf(part) === index)
    .join(", ");
  return {
    city,
    address,
    addressLine1: "",
    state: result.principalSubdivision ?? "",
    postalCode: result.postcode ?? "",
    countryCode: result.countryCode?.toUpperCase() ?? "",
  };
}

// Minimal shapes for the globals the script defines — enough to use it without
// pulling in @types/google.maps for one screen.
/* eslint-disable @typescript-eslint/no-explicit-any */
declare global {
  interface Window {
    google?: any;
    __smSignupMapsLoaded?: () => void;
  }
}

let scriptPromise: Promise<void> | null = null;

/** Load the Maps script once per page, whatever how many components ask. */
function loadMaps(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  if (window.google?.maps?.Geocoder && window.google?.maps?.Map)
    return Promise.resolve();
  if (scriptPromise) return scriptPromise;

  scriptPromise = new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    const timeout = window.setTimeout(() => fail(), 10000);
    const cleanup = () => {
      window.clearTimeout(timeout);
      delete window.__smSignupMapsLoaded;
    };
    const fail = () => {
      cleanup();
      script.remove();
      scriptPromise = null;
      reject(new Error("maps script failed to load"));
    };
    window.__smSignupMapsLoaded = () => {
      cleanup();
      resolve();
    };
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(MAPS_KEY)}&loading=async&callback=__smSignupMapsLoaded`;
    script.async = true;
    // With loading=async, script.onload fires before the Maps API is ready.
    script.onerror = fail;
    document.head.appendChild(script);
  });
  return scriptPromise;
}

export function LocationPicker({
  value,
  onChange,
}: {
  value: PickedLocation;
  onChange: (next: PickedLocation) => void;
}) {
  const mapRef = useRef<HTMLDivElement | null>(null);
  const mapObj = useRef<any>(null);
  const markerObj = useRef<any>(null);
  const geocoder = useRef<any>(null);

  const [mapState, setMapState] = useState<
    "off" | "loading" | "ready" | "failed"
  >(MAPS_KEY ? "loading" : "off");
  const [locating, setLocating] = useState(false);
  const [geoError, setGeoError] = useState("");

  // Keep the latest onChange without re-running the map effect on every render.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const requestSequence = useRef(0);
  /** Resolve the address independently of map rendering, then fill known fields. */
  const describe = useCallback(
    async (lat: number, lng: number, currentDevice = false) => {
      const request = ++requestSequence.current;
      let place: PickedLocation = {
        lat,
        lng,
        address: "",
        addressLine1: "",
        addressLine2: "",
        city: "",
        state: "",
        postalCode: "",
        countryCode: "",
      };
      if (MAPS_KEY) {
        try {
          await loadMaps();
          geocoder.current ??= new window.google.maps.Geocoder();
          let timeout: ReturnType<typeof setTimeout> | undefined;
          const results = await new Promise<GoogleAddressResult[]>(
            (resolve, reject) => {
              timeout = setTimeout(
                () => reject(new Error("geocoder timed out")),
                8000,
              );
              geocoder.current.geocode(
                { location: { lat, lng } },
                (results: GoogleAddressResult[], status: string) => {
                  clearTimeout(timeout);
                  if (status === "OK" && results?.length) resolve(results);
                  else reject(new Error("geocoder unavailable"));
                },
              );
            },
          ).finally(() => clearTimeout(timeout));
          place = { lat, lng, ...googleAddress(results) };
        } catch {
          /* Continue with current-device locality suggestions below. */
        }
      }
      // The free client endpoint only permits the device's actual location;
      // a clicked/dragged map pin must never be sent to it.
      if (
        currentDevice &&
        (!place.city || !place.state || !place.postalCode || !place.countryCode)
      ) {
        try {
          const locality = await describeCurrentLocation(lat, lng);
          place = {
            ...place,
            city: place.city || locality.city,
            state: place.state || locality.state,
            postalCode: place.postalCode || locality.postalCode,
            countryCode: place.countryCode || locality.countryCode,
            address: place.address || locality.address,
          };
        } catch {
          /* Keep any Google fields, and leave unresolved values editable. */
        }
      }
      if (request !== requestSequence.current) return;
      onChangeRef.current(place);
      setGeoError(locationNotice(place));
    },
    [],
  );

  // Build the map once the script is in.
  useEffect(() => {
    if (!MAPS_KEY) return;
    let cancelled = false;

    loadMaps()
      .then(() => {
        if (cancelled || !mapRef.current || !window.google?.maps) return;
        const start =
          value.lat != null && value.lng != null
            ? { lat: value.lat, lng: value.lng }
            : FALLBACK_CENTRE;

        mapObj.current = new window.google.maps.Map(mapRef.current, {
          center: start,
          zoom: value.lat != null ? 15 : 4,
          disableDefaultUI: true,
          zoomControl: true,
        });
        markerObj.current = new window.google.maps.Marker({
          position: start,
          map: mapObj.current,
          draggable: true,
        });
        geocoder.current = new window.google.maps.Geocoder();

        // Dragging the pin IS the correction mechanism — a reverse-geocode is
        // often a street off, and the merchant knows their own shop.
        markerObj.current.addListener("dragend", () => {
          const pos = markerObj.current.getPosition();
          describe(pos.lat(), pos.lng());
        });
        mapObj.current.addListener("click", (e: any) => {
          markerObj.current.setPosition(e.latLng);
          describe(e.latLng.lat(), e.latLng.lng());
        });

        setMapState("ready");
      })
      .catch(() => {
        if (!cancelled) setMapState("failed");
      });

    return () => {
      cancelled = true;
    };
    // Deliberately once: re-running would rebuild the map under the merchant.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Move the pin when the value changes from outside (the locate button).
  useEffect(() => {
    if (mapState !== "ready" || value.lat == null || value.lng == null) return;
    const pos = { lat: value.lat, lng: value.lng };
    markerObj.current?.setPosition(pos);
    mapObj.current?.setCenter(pos);
    mapObj.current?.setZoom(16);
  }, [mapState, value.lat, value.lng]);

  /** Browser geolocation — free, keyless, and works with the map switched off. */
  const locate = () => {
    if (!navigator.geolocation) {
      setGeoError("This browser can't share your location.");
      return;
    }
    setGeoError("");
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        await describe(pos.coords.latitude, pos.coords.longitude, true);
        setLocating(false);
      },
      (err) => {
        setLocating(false);
        setGeoError(
          err.code === err.PERMISSION_DENIED
            ? "Location permission was denied. You can still type your address below."
            : "Couldn't get your location. You can still type your address below.",
        );
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 },
    );
  };

  return (
    <div className="flex flex-col gap-3">
      <button
        type="button"
        onClick={locate}
        disabled={locating}
        className="stq-btn inline-flex h-11 items-center justify-center gap-2 rounded-lg border border-gray-300 bg-white px-4 text-sm font-semibold text-gray-800 hover:border-gray-400 disabled:opacity-60"
      >
        {locating ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <LocateFixed className="h-4 w-4" />
        )}
        {locating ? "Finding you…" : "Use my current location"}
      </button>

      {geoError && (
        <p role="status" className="text-sm text-gray-600">
          {geoError}
        </p>
      )}

      {mapState !== "off" && (
        <div className="relative h-56 overflow-hidden rounded-xl border border-gray-200 bg-gray-50">
          <div ref={mapRef} className="h-full w-full" />
          {mapState === "loading" && (
            <div className="absolute inset-0 flex items-center justify-center text-sm text-gray-500">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading map…
            </div>
          )}
          {mapState === "failed" && (
            <div className="absolute inset-0 flex items-center justify-center px-6 text-center text-sm text-gray-500">
              The map couldn&apos;t load. Your location below is still saved.
            </div>
          )}
        </div>
      )}

      {value.lat != null && value.lng != null && (
        <p className="flex items-start gap-1.5 text-xs text-gray-500">
          <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            {value.address ||
              `${value.lat.toFixed(5)}, ${value.lng.toFixed(5)}`}
            {mapState === "ready" && " — drag the pin to adjust."}
          </span>
        </p>
      )}
    </div>
  );
}
