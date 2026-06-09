// Creates a macOS "Multi-Output Device" (a stacked aggregate) via CoreAudio, so
// setup doesn't have to walk the user through Audio MIDI Setup by hand.
//
// Usage: create-multi-output <AggregateName> <SubDevice1Name> <SubDevice2Name> ...
// The first sub-device is used as the clock master. Sub-devices are matched by
// their CoreAudio name (e.g. "BlackHole 2ch", "MacBook Air Speakers").
//
// Compiled + run by `npm run setup`. Prints the new device name on success;
// exits non-zero (with a message on stderr) on failure so setup can fall back to
// guided manual steps.

import CoreAudio
import Foundation

func err(_ s: String) { FileHandle.standardError.write((s + "\n").data(using: .utf8)!) }

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

func stringProp(_ id: AudioDeviceID, _ selector: AudioObjectPropertySelector) -> String? {
    var addr = AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var size = UInt32(MemoryLayout<CFString?>.size)
    var value: CFString? = nil
    let status = withUnsafeMutablePointer(to: &value) {
        AudioObjectGetPropertyData(id, &addr, 0, nil, &size, $0)
    }
    guard status == noErr, let v = value else { return nil }
    return v as String
}

func uid(byName target: String) -> String? {
    for id in allDeviceIDs() {
        if stringProp(id, kAudioObjectPropertyName) == target {
            return stringProp(id, kAudioDevicePropertyDeviceUID)
        }
    }
    return nil
}

let args = CommandLine.arguments
guard args.count >= 4 else {
    err("usage: create-multi-output <AggregateName> <Sub1> <Sub2> ...")
    exit(2)
}
let aggName = args[1]
let subNames = Array(args.dropFirst(2))

var subUIDs: [String] = []
for n in subNames {
    guard let u = uid(byName: n) else {
        err("audio device not found: \(n)")
        exit(3)
    }
    subUIDs.append(u)
}

let description: [String: Any] = [
    kAudioAggregateDeviceNameKey as String: aggName,
    kAudioAggregateDeviceUIDKey as String: "com.otto.callagent.monitor",
    kAudioAggregateDeviceSubDeviceListKey as String: subUIDs.map { [kAudioSubDeviceUIDKey as String: $0] },
    kAudioAggregateDeviceMasterSubDeviceKey as String: subUIDs[0],
    kAudioAggregateDeviceIsStackedKey as String: 1, // 1 = multi-output (stacked)
]

var deviceID: AudioDeviceID = 0
let status = AudioHardwareCreateAggregateDevice(description as CFDictionary, &deviceID)
if status != noErr {
    err("AudioHardwareCreateAggregateDevice failed: \(status)")
    exit(4)
}
print(aggName)
