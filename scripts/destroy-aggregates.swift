// Destroys any private aggregate devices Otto may have left behind after a crash
// (normally they're auto-removed when the helper exits). Safe to run anytime —
// it only touches devices created by Otto, identified by our own UIDs.
//
// Run via: swift scripts/destroy-aggregates.swift

import CoreAudio
import Foundation

let OTTO_UIDS: Set<String> = [
    "com.otto.callagent.systemtap", // the process-tap aggregate
    "com.otto.callagent.monitor",   // the old Multi-Output device (pre-tap builds)
]

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

func uidOf(_ id: AudioDeviceID) -> String? {
    var addr = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyDeviceUID, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var size = UInt32(MemoryLayout<CFString?>.size)
    var value: CFString? = nil
    let status = withUnsafeMutablePointer(to: &value) { AudioObjectGetPropertyData(id, &addr, 0, nil, &size, $0) }
    guard status == noErr, let v = value else { return nil }
    return v as String
}

var removed = 0
for id in allDeviceIDs() {
    if let u = uidOf(id), OTTO_UIDS.contains(u) {
        if AudioHardwareDestroyAggregateDevice(id) == noErr { removed += 1 }
    }
}
print("removed \(removed) leftover Otto device(s)")
