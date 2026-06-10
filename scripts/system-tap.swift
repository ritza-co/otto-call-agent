// Otto — system-audio tap (macOS 14.4+).
//
// Captures the system output MIX (everything you hear: the call's incoming
// audio, etc.) WITHOUT changing your output device, using a CoreAudio process
// tap. Your speakers/headphones keep working exactly as before — the tap is a
// passive copy. Audio is downmixed to mono 16-bit PCM and written to stdout for
// the Node side to feed to Deepgram. The tap's native sample rate is printed to
// stderr as "@RATE <n>" before any audio.
//
// Everything created here is PRIVATE and EPHEMERAL: a private tap + a private
// aggregate device, both destroyed on exit (and any stale one from a previous
// crash is destroyed at startup by UID). Nothing persists in the user's audio
// settings, so there is nothing to "uninstall".
//
// Compiled to bin/otto-tap by `npm run setup` (or run via `swift`).

import AVFoundation
import CoreAudio
import Foundation

func errln(_ s: String) { FileHandle.standardError.write((s + "\n").data(using: .utf8)!) }

let AGG_UID = "com.otto.callagent.systemtap"

// --- helpers (find/destroy our private aggregate by UID) ---------------------
func allDeviceIDs() -> [AudioDeviceID] {
    var addr = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDevices,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size) == noErr else { return [] }
    let count = Int(size) / MemoryLayout<AudioDeviceID>.size
    var ids = [AudioDeviceID](repeating: 0, count: count)
    guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &ids) == noErr else { return [] }
    return ids
}

func stringProp(_ id: AudioObjectID, _ selector: AudioObjectPropertySelector) -> String? {
    var addr = AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var size = UInt32(MemoryLayout<CFString?>.size)
    var value: CFString? = nil
    let status = withUnsafeMutablePointer(to: &value) {
        AudioObjectGetPropertyData(id, &addr, 0, nil, &size, $0)
    }
    guard status == noErr, let v = value else { return nil }
    return v as String
}

func destroyStaleAggregate() {
    for id in allDeviceIDs() where stringProp(id, kAudioDevicePropertyDeviceUID) == AGG_UID {
        AudioHardwareDestroyAggregateDevice(id)
    }
}

// --- TCC: system-audio capture permission ------------------------------------
// CoreAudio process taps gate on kTCCServiceAudioCapture — a DIFFERENT permission
// from "Screen & System Audio Recording". Without it the tap silently delivers
// zeros (no error). We preflight (and request if needed) via TCC's private SPI,
// exactly as Apple's AudioCap sample does, and report the status on stderr.
typealias TCCPreflight = @convention(c) (CFString, CFDictionary?) -> Int
typealias TCCRequest = @convention(c) (CFString, CFDictionary?, @escaping (Bool) -> Void) -> Void

func tccSym<T>(_ name: String, _ type: T.Type) -> T? {
    guard let h = dlopen("/System/Library/PrivateFrameworks/TCC.framework/Versions/A/TCC", RTLD_NOW),
          let s = dlsym(h, name) else { return nil }
    return unsafeBitCast(s, to: T.self)
}

let tccService = "kTCCServiceAudioCapture" as CFString
if let preflight = tccSym("TCCAccessPreflight", TCCPreflight.self) {
    var status = preflight(tccService, nil) // 0=authorized, 1=denied, 2=unknown
    errln("@AUTH preflight=\(status) (0=authorized 1=denied 2=undetermined)")
    if status != 0, let request = tccSym("TCCAccessRequest", TCCRequest.self) {
        errln("@AUTH requesting audio-capture permission…")
        let sem = DispatchSemaphore(value: 0)
        var granted = false
        request(tccService, nil) { g in granted = g; sem.signal() }
        while sem.wait(timeout: .now() + 0.05) == .timedOut {
            RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.05)) // pump for the prompt callback
        }
        status = preflight(tccService, nil)
        errln("@AUTH granted=\(granted) preflightAfter=\(status)")
    }
    if status != 0 {
        errln("@AUTH NOT authorized for system-audio capture — tap will be silent.")
    }
} else {
    errln("@AUTH could not load TCC SPI (continuing; tap may be silent if unauthorized)")
}

// --- build the tap -----------------------------------------------------------
destroyStaleAggregate()

// Global tap of the whole system output mix, excluding no processes. Private so
// it never shows up as a selectable device; unmuted so you still hear everything.
let tapDesc = CATapDescription(stereoGlobalTapButExcludeProcesses: [])
tapDesc.isPrivate = true
tapDesc.muteBehavior = .unmuted

var tapID = AudioObjectID(kAudioObjectUnknown)
let tapStatus = AudioHardwareCreateProcessTap(tapDesc, &tapID)
guard tapStatus == noErr, tapID != kAudioObjectUnknown else {
    errln("AudioHardwareCreateProcessTap failed: \(tapStatus). If this is -4 (unimpl) or a permission error, grant Audio Recording to your terminal in System Settings › Privacy & Security.")
    exit(4)
}

// Wrap the tap in a private aggregate device so we can pull its audio with an IOProc.
let aggDesc: [String: Any] = [
    kAudioAggregateDeviceNameKey as String: "Otto System Tap",
    kAudioAggregateDeviceUIDKey as String: AGG_UID,
    kAudioAggregateDeviceIsPrivateKey as String: true,   // ephemeral, not user-visible
    kAudioAggregateDeviceIsStackedKey as String: false,
    kAudioAggregateDeviceTapAutoStartKey as String: true,
    kAudioAggregateDeviceTapListKey as String: [
        [
            kAudioSubTapUIDKey as String: tapDesc.uuid.uuidString,
            kAudioSubTapDriftCompensationKey as String: true,
        ]
    ],
]

var aggID = AudioObjectID(kAudioObjectUnknown)
let aggStatus = AudioHardwareCreateAggregateDevice(aggDesc as CFDictionary, &aggID)
guard aggStatus == noErr, aggID != kAudioObjectUnknown else {
    errln("AudioHardwareCreateAggregateDevice failed: \(aggStatus)")
    AudioHardwareDestroyProcessTap(tapID)
    exit(5)
}

// --- read the tap's stream format -------------------------------------------
var fmtAddr = AudioObjectPropertyAddress(
    mSelector: kAudioDevicePropertyStreamFormat,
    mScope: kAudioObjectPropertyScopeInput,
    mElement: 0)
var asbd = AudioStreamBasicDescription()
var asbdSize = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
let fmtStatus = AudioObjectGetPropertyData(aggID, &fmtAddr, 0, nil, &asbdSize, &asbd)
guard fmtStatus == noErr, asbd.mSampleRate > 0 else {
    errln("could not read tap stream format: \(fmtStatus)")
    AudioHardwareDestroyAggregateDevice(aggID)
    AudioHardwareDestroyProcessTap(tapID)
    exit(6)
}

let sampleRate = Int(asbd.mSampleRate)
let isFloat = (asbd.mFormatFlags & kAudioFormatFlagIsFloat) != 0
// Tell the Node side the native rate before any PCM bytes.
errln("@RATE \(sampleRate)")
errln("@INFO tap format: \(sampleRate) Hz, \(asbd.mChannelsPerFrame) ch, \(isFloat ? "float32" : "int")")

let stdout = FileHandle.standardOutput
var alive = true

// --- IOProc: downmix to mono Int16 and write to stdout -----------------------
var procID: AudioDeviceIOProcID?
let ioStatus = AudioDeviceCreateIOProcIDWithBlock(&procID, aggID, nil) {
    (_, inInputData, _, _, _) in
    guard alive else { return }
    let bufList = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: inInputData))
    guard bufList.count > 0 else { return }

    // Determine frame count from the first buffer.
    let first = bufList[0]
    let chansInFirst = Int(first.mNumberChannels)
    guard chansInFirst > 0 else { return }
    let bytesPerSample = 4 // float32 or int32 both 4 bytes; we treat as float
    let frames = Int(first.mDataByteSize) / (bytesPerSample * chansInFirst)
    guard frames > 0 else { return }

    var out = [Int16](repeating: 0, count: frames)

    if bufList.count > 1 {
        // Non-interleaved: one buffer per channel. Average across channels.
        let nch = bufList.count
        for f in 0..<frames {
            var acc: Float = 0
            for c in 0..<nch {
                if let p = bufList[c].mData?.assumingMemoryBound(to: Float.self) {
                    acc += p[f]
                }
            }
            let v = max(-1.0, min(1.0, acc / Float(nch)))
            out[f] = Int16(v * 32767.0)
        }
    } else {
        // Interleaved: chansInFirst channels packed per frame.
        guard let p = first.mData?.assumingMemoryBound(to: Float.self) else { return }
        let nch = chansInFirst
        for f in 0..<frames {
            var acc: Float = 0
            for c in 0..<nch { acc += p[f * nch + c] }
            let v = max(-1.0, min(1.0, acc / Float(nch)))
            out[f] = Int16(v * 32767.0)
        }
    }

    out.withUnsafeBytes { raw in
        let data = Data(bytes: raw.baseAddress!, count: raw.count)
        do { try stdout.write(contentsOf: data) }
        catch { alive = false } // pipe closed (Node exited) → stop
    }
}
guard ioStatus == noErr, let proc = procID else {
    errln("AudioDeviceCreateIOProcIDWithBlock failed: \(ioStatus)")
    AudioHardwareDestroyAggregateDevice(aggID)
    AudioHardwareDestroyProcessTap(tapID)
    exit(7)
}

// --- teardown ----------------------------------------------------------------
func teardown() {
    alive = false
    AudioDeviceStop(aggID, proc)
    AudioDeviceDestroyIOProcID(aggID, proc)
    AudioHardwareDestroyAggregateDevice(aggID)
    AudioHardwareDestroyProcessTap(tapID)
}

// Signal handlers just flip `alive`; the run loop below then exits and runs
// teardown() on the main thread (keeps cleanup off the signal context).
let sigHandler: @convention(c) (Int32) -> Void = { _ in alive = false }
signal(SIGINT, sigHandler)
signal(SIGTERM, sigHandler)
signal(SIGPIPE, SIG_IGN) // we detect the closed pipe via the write error instead

let startStatus = AudioDeviceStart(aggID, proc)
guard startStatus == noErr else {
    errln("AudioDeviceStart failed: \(startStatus)")
    teardown()
    exit(8)
}

errln("@READY")
// Run until the pipe closes or we're signalled. Poll `alive` so a closed stdout
// (Node gone) also ends us.
while alive { RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.25)) }
teardown()
