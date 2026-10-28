import { loadNativeModule } from './nativeModuleLoader';
import { filterSelectableDevices } from './audioDeviceSelection.mjs';
import { rendererCaptureFallbackActive } from './fallback/fallbackPolicy';

// NativeModule may be null if the Rust binary isn't built yet (new clone without `npm run build:native`).
// All methods below handle this gracefully by returning empty arrays.
const NativeModule: any = loadNativeModule();
const { getInputDevices, getOutputDevices } = NativeModule || {};

export interface AudioDevice {
    id: string;
    name: string;
}

export class AudioDevices {
    public static getInputDevices(): AudioDevice[] {
        if (!getInputDevices) {
            console.warn('[AudioDevices] Native functionality not available');
            return [];
        }
        try {
            // Natively's own system-audio tap is an aggregate device that cpal
            // enumerates as an INPUT while a meeting is capturing (private
            // aggregates are hidden from other processes, not from ours). Left
            // unfiltered it appears in the mic dropdown, gets persisted as
            // preferredInputDeviceId, and then breaks every later meeting —
            // the tap does not exist yet when the mic channel starts. Filtering
            // at this single choke point also keeps the I/O-conflict fallback,
            // the built-in-mic lookup and the last-resort candidate ladder in
            // main.ts from ever selecting it.
            return filterSelectableDevices(getInputDevices());
        } catch (e) {
            console.error('[AudioDevices] Failed to get input devices:', e);
            return [];
        }
    }

    /**
     * Input devices, with the Chromium fallback for the case where the native
     * module is absent — Windows without the VC++ runtime (the documented
     * fallback case) and macOS development builds forced with
     * NATIVELY_FORCE_RENDERER_AUDIO=1.
     *
     * Capture already works through the capture page in that state; only
     * ENUMERATION was missing, which made Settings › Audio and the transcript
     * panel say "No microphones found." while the mic was in fact usable.
     *
     * Synchronous callers (the device-selection ladders in main.ts) keep using
     * getInputDevices(): an empty list there means "unverifiable", which they
     * already handle by keeping the current device. Only the IPC the picker
     * reads is upgraded to the async form.
     */
    public static async getInputDevicesWithFallback(): Promise<AudioDevice[]> {
        const native = AudioDevices.getInputDevices();
        if (native.length > 0) return native;
        if (!rendererCaptureFallbackActive(false)) return native;
        try {
            const { captureHost } = require('./fallback/captureHost') as typeof import('./fallback/captureHost');
            const devices = await captureHost().listInputDevices();
            // Same internal-capture filter the native path applies: the tap
            // aggregate must never be offered as a microphone.
            return filterSelectableDevices(devices);
        } catch (e) {
            console.warn('[AudioDevices] Chromium device enumeration failed:', e);
            return native;
        }
    }

    public static getOutputDevices(): AudioDevice[] {
        if (!getOutputDevices) {
            console.warn('[AudioDevices] Native functionality not available');
            return [];
        }
        try {
            // Same leak on the output side: the tap aggregate is built with
            // main_sub_device/sub_device_list pointing at the real output UID,
            // so it reports output buffers and is admitted by
            // list_output_devices(). Probed while a tap was running, it
            // enumerated AHEAD of the real speaker.
            return filterSelectableDevices(getOutputDevices());
        } catch (e) {
            console.error('[AudioDevices] Failed to get output devices:', e);
            return [];
        }
    }
}
