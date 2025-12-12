// import * as LiveKit from 'livekit-client';

// LiveKit will be imported dynamically
import { createLocalScreenTracks, LocalVideoTrack } from "./livekit-client.esm.mjs";

let LiveKit = null;

const shareScreenBtn = document.getElementById('shareScreen')
const stopShareBtn = document.getElementById('stopShare')
const screenView = document.getElementById('screenView');
const exitAppBtn = document.getElementById('exitApp')
const lmsFrame = document.getElementById('lmsFrame')
const body = document.body

let stream = null
let room = null
let livekitRoom = null
let livekitConnected = false
let uploadInterval = null;

// Store current exam data for audit logging
let currentExamData = {
    sqid: null,
    qr: null
};

const CONFIG = {
    BASE_API_URL: 'http://localhost:8383/api/v1',
    EXAM_BASE_URL: 'http://localhost:8384/api/v1',
    BASE_LMS_URL: 'http://localhost:3001/lms-mc',
    KURENTO: 'wss://localhost:8443/kurento-group-call/groupcall',
    BASE_LANDING: './landing.html'
};

// LiveKit Configuration
const LIVEKIT_CONFIG = {
    url: 'wss://live.codepulsesolution.com/',
    token: '\n' +
        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJ0c2xpdmVraXQiLCJleHAiOjE3NzA5OTQ1NjIsInN1YiI6ImRmQGdtYWlsLmNvbSIsIm5hbWUiOiJEIEZlcm5hbmRvIiwibWV0YWRhdGEiOiJtZXRhZGF0YSIsInZpZGVvIjp7InJvb21Kb2luIjp0cnVlLCJyb29tIjoiZGVtb19jbGFzcyIsImNhblB1Ymxpc2hEYXRhIjp0cnVlLCJjYW5QdWJsaXNoIjp0cnVlLCJjYW5TdWJzY3JpYmUiOmZhbHNlfSwic2lwIjp7fX0.VA8AxvUHB5-C4XO7JgIu8phaNR-WZYoc21I_g8F0A_Q',
    roomName: 'demo_class',
    participantName: 'Screen Sharer'
};

// Audit logging function
const sendAuditLog = async (description) => {
    try {
        const id = currentExamData.sqid;
        
        // Get device type and app version
        let deviceType = 'Unknown';
        let appVersion = '';
        
        try {
            // getPlatform is synchronous, no await needed
            const platform = window.electronAPI.getPlatform();
            // Map platform to readable device type
            if (platform === 'darwin') {
                deviceType = 'Mac';
            } else if (platform === 'win32') {
                deviceType = 'Windows';
            } else if (platform === 'linux') {
                deviceType = 'Linux';
            }
            
            // Get app version if available (this is async)
            if (window.electronAPI && window.electronAPI.getAppVersion) {
                appVersion = await window.electronAPI.getAppVersion();
            }
        } catch (error) {
            console.error('Error getting device info:', error);
        }
        
        // Append device type and version to description
        let fullDescription = description || "";
        if (deviceType !== 'Unknown' || appVersion) {
            const deviceInfo = [];
            if (deviceType !== 'Unknown') {
                deviceInfo.push(deviceType);
            }
            if (appVersion) {
                deviceInfo.push(`v${appVersion}`);
            }
            if (deviceInfo.length > 0) {
                fullDescription = `${description} [${deviceInfo.join(', ')}]`;
            }
        }
         
        const auditData = {
             sqid: id ? parseInt(id) : 0,
            description: fullDescription
        };
        
        const userToken = localStorage.getItem('user_token');
        
        fetch(`${CONFIG.EXAM_BASE_URL}/vle/quiz/audit-log`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': userToken || ''
            },
            body: JSON.stringify(auditData)
        }).catch((e) => {
            console.error('Audit log error:', e);
        });
    } catch (error) {
        console.error('Audit log error:', error);
    }
};

const openScreenShare = async (quizId, examInfo, sqid) => {
    console.info('openScreenShare')
    try {
        const sources = await window.electronAPI.getSources();
        const platform = await window.electronAPI.getPlatform();

        let selectedSource = sources.find(source => {
            if (platform === 'darwin') {
                return source.name.includes('Entire screen') || source.display_id === '1';
            } else if (platform === 'win32') {
                return source.name.includes('Screen') || source.display_id.includes('DISPLAY');
            } else {
                return source.name.includes('Screen');
            }
        });

        if (!selectedSource) {
            selectedSource = sources[0];
        }

        console.log('-------Selected source:', selectedSource);
        console.log('🎥 Attempting to get screen stream using getDisplayMedia...');

        // Use getDisplayMedia for proper screen sharing
        try {
            stream = await navigator.mediaDevices.getDisplayMedia({
                audio: false,
                video: true
            });

            console.log('✅ Screen stream obtained using getDisplayMedia');
        } catch (error) {
            console.error('❌ getDisplayMedia failed:', error.name, error.message);

            if (error.name === 'InvalidStateError' && error.message.includes('transient activation')) {
                console.error('❌ Screen sharing requires user gesture. Please click a button first.');
            } else if (error.name === 'NotReadableError') {
                console.error('❌ Screen capture source not readable. This might be due to:');
                console.error('   - Screen recording permissions not granted');
                console.error('   - Another app using screen capture');
                console.error('   - System restrictions');
            }

            // Fallback to Electron's desktop capturer
            console.log('🔄 Falling back to Electron desktop capturer...');
            try {
                stream = await navigator.mediaDevices.getUserMedia({
                    audio: false,
                    video: {
                        mandatory: {
                            chromeMediaSource: 'desktop',
                            chromeMediaSourceId: selectedSource.id,
                            minWidth: 960,
                            maxWidth: 960,
                            minHeight: 540,
                            maxHeight: 540,
                            maxFrameRate: 15,
                        }
                    }
                });
                console.log('✅ Screen stream obtained using Electron desktop capturer fallback');
                console.log('📺 Fallback stream details:', {
                    id: stream.id,
                    active: stream.active,
                    tracks: stream.getTracks().map(track => ({
                        kind: track.kind,
                        label: track.label,
                        enabled: track.enabled,
                        readyState: track.readyState
                    }))
                });
            } catch (fallbackError) {
                console.error('❌ Electron desktop capturer fallback also failed:', fallbackError.name, fallbackError.message);
                throw new Error(`Both getDisplayMedia and desktop capturer failed. getDisplayMedia: ${error.message}, Desktop capturer: ${fallbackError.message}`);
            }
        }

        // 🟢 Detect when screen sharing stops
        stream.getVideoTracks()[0].addEventListener('ended', async () => {
            console.log('Screen sharing stopped by the user or system');
            body.classList.remove('screen-sharing-active');
            shareScreenBtn.disabled = false;
            stopShareBtn.disabled = true;

            if (uploadInterval) {
                clearInterval(uploadInterval);
                uploadInterval = null;
            }

            // Disconnect from LiveKit
            // await disconnectFromLiveKit();

            // Optionally, notify backend or clean up resources
            // 🔁 Restart screen sharing
            openScreenShare(quizId, examInfo, sqid);
        });

        // screenView.srcObject = stream;
        // body.classList.add('screen-sharing-active');
        shareScreenBtn.disabled = true;
        stopShareBtn.disabled = false;

        // === Kurento Setup ===
        // const ws_token = localStorage.getItem('ws_token');
        // const userDetails = JSON.parse(localStorage.getItem('user_details'));
        // console.log(userDetails);
        // const username = userDetails.email + '_scrn';
        // const password = userDetails.id;
        // const roomName = "demo_class"; // replace with actual room name
        // const screenSharerName = username;

        // const streamUrl = `${CONFIG.KURENTO}?token=${ws_token}&user=${username}&pass=${password}`;
        // const ws = new WebSocket(streamUrl);
        //
        // ws.onopen = () => {
        //     ws.send(JSON.stringify({
        //         id: 'joinRoom',
        //         name: screenSharerName,
        //         room:   roomName
        //     }));
        //
        //     publishToKurento(ws, stream, screenSharerName);
        // };

        // === LiveKit Integration ===
        // Connect to LiveKit for screen sharing
        console.log('🔗 Starting LiveKit connection...');
        // await connectToLiveKit(stream, quizId, examInfo);

        // Start screen capture upload only if shareScreen is true
        if (examInfo?.shareScreen) {
            console.log('📸 Starting screen capture upload (shareScreen is enabled)');
            if (uploadInterval) clearInterval(uploadInterval);
            uploadInterval = setInterval(() => {
                uploadScreenCapture(sqid);
            }, 10000);
        } else {
            console.log('⏭️ Skipping screen capture upload (shareScreen is disabled)');
            // Clear any existing interval if shareScreen is disabled
            if (uploadInterval) {
                clearInterval(uploadInterval);
                uploadInterval = null;
            }
        }

    } catch (err) {
        console.error('Error sharing screen:', err);
        //alert('Error sharing screen: ' + err.message);
    }
};
shareScreenBtn.addEventListener('click', async () => {
    try {
        // Ensure we have user gesture for getDisplayMedia
        // For testing, create a mock exam info with both camera and screen enabled
        const mockExamInfo = {
            id: 9026,
            shareScreen: true,
            camera: true,
            qname: 'Test Exam'
        };
        await openScreenShare('9026', mockExamInfo, '1');
    } catch (error) {
        console.error('Error starting screen share:', error);
        if (error.name === 'InvalidStateError') {
            alert('Please click the button again to start screen sharing.');
        }
    }
});

// === WebRTC + Kurento ===
const publishToKurento = async (ws, stream, screenSharerName) => {
    const pc = new RTCPeerConnection();

    stream.getTracks().forEach(track => {
        pc.addTrack(track, stream);
    });

    pc.onicecandidate = (event) => {
        if (event.candidate) {
            ws.send(JSON.stringify({
                id: 'onIceCandidate',
                name: screenSharerName,
                candidate: event.candidate
            }));
        }
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    ws.send(JSON.stringify({
        id: 'receiveVideoFrom',
        sender: screenSharerName,
        sdpOffer: offer.sdp
    }));

    ws.onmessage = async (message) => {
        const msg = JSON.parse(message.data);

        if (msg.id === 'receiveVideoAnswer') {
            await pc.setRemoteDescription(new RTCSessionDescription({
                type: 'answer',
                sdp: msg.sdpAnswer
            }));
        } else if (msg.id === 'iceCandidate') {
            await pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
        }
    };
};

// === LiveKit Functions ===
const connectToLiveKit = async (screenStream, quizId, examInfo) => {
    try {
        console.log('🔗 Connecting to LiveKit...');

        // Dynamically import LiveKit
        if (!LiveKit) {
            console.log('📦 Loading LiveKit library...');
            LiveKit = await import('./node_modules/livekit-client/dist/livekit-client.esm.mjs');
            console.log('✅ LiveKit library loaded:', Object.keys(LiveKit));
        }

        // Create room options
        const roomOptions = {
            adaptiveStream: true,
            dynacast: true,
            publishDefaults: {
                simulcast: true
            },
            videoCaptureDefaults: {
                resolution: { width: 960, height: 540 }
            }
        };

        // Create room instance
        livekitRoom = new LiveKit.Room(roomOptions);

        // Set up event handlers
        console.log('🔧 Setting up LiveKit event handlers...');

        livekitRoom.on(LiveKit.RoomEvent.Connected, () => {
            console.log('✅ Connected to LiveKit room');
            livekitConnected = true;
            handleLiveKitConnected(livekitRoom, screenStream, examInfo);
        });

        // Add debugging for all room events
        livekitRoom.on(LiveKit.RoomEvent.Connecting, () => {
            console.log('🔄 LiveKit connecting...');
        });

        livekitRoom.on(LiveKit.RoomEvent.Reconnecting, () => {
            console.log('🔄 LiveKit reconnecting...');
        });

        livekitRoom.on(LiveKit.RoomEvent.Reconnected, () => {
            console.log('✅ LiveKit reconnected');
        });

        livekitRoom.on(LiveKit.RoomEvent.Disconnected, (reason) => {
            console.log('❌ Disconnected from LiveKit room:', reason);
            livekitConnected = false;
            handleLiveKitDisconnected();
        });

        livekitRoom.on(LiveKit.RoomEvent.ConnectionStateChanged, (state) => {
            console.log('🔄 LiveKit connection state changed:', state);
        });

        livekitRoom.on(LiveKit.RoomEvent.Reconnecting, () => {
            console.log('🔄 LiveKit reconnecting...');
        });

        livekitRoom.on(LiveKit.RoomEvent.Reconnected, () => {
            console.log('✅ LiveKit reconnected');
        });

        livekitRoom.on(LiveKit.RoomEvent.ParticipantConnected, (participant) => {
            console.log('👤 Participant connected:', participant.identity);
            console.log('👤 Participant details:', {
                identity: participant.identity,
                name: participant.name,
                isLocal: participant.isLocal,
                connectionQuality: participant.connectionQuality
            });
            renderParticipant(participant);
        });

        livekitRoom.on(LiveKit.RoomEvent.ParticipantDisconnected, (participant) => {
            console.log('👋 Participant disconnected:', participant.identity);
            removeParticipant(participant.identity);
        });

        livekitRoom.on(LiveKit.RoomEvent.TrackSubscribed, (track, publication, participant) => {
            console.log('📺 Track subscribed:', track.kind, 'from', participant.identity);
            renderTrack(track, participant);
        });

        livekitRoom.on(LiveKit.RoomEvent.TrackUnsubscribed, (track, publication, participant) => {
            console.log('📺 Track unsubscribed:', track.kind, 'from', participant.identity);
            removeTrack(track, participant);
        });

        livekitRoom.on(LiveKit.RoomEvent.TrackPublished, (publication, participant) => {
            console.log('📤 Track published:', publication.trackName, 'by', participant.identity, 'source:', publication.source);
        });

        livekitRoom.on(LiveKit.RoomEvent.TrackUnpublished, (publication, participant) => {
            console.log('📤 Track unpublished:', publication.trackName, 'by', participant.identity);
        });

        livekitRoom.on(LiveKit.RoomEvent.LocalTrackPublished, (publication, participant) => {
            console.log('📤 Local track published:', publication.trackName, 'source:', publication.source);
        });

        livekitRoom.on(LiveKit.RoomEvent.LocalTrackUnpublished, (publication, participant) => {
            console.log('📤 Local track unpublished:', publication.trackName);
        });

        // Connect to room
        console.log('🌐 Attempting to connect to:', LIVEKIT_CONFIG.url);
        console.log('🎫 Using token:', LIVEKIT_CONFIG.token.substring(0, 50) + '...');

        // Connect to room with minimal configuration
        const connectPromise = livekitRoom.connect(LIVEKIT_CONFIG.url, LIVEKIT_CONFIG.token, {
            autoSubscribe: true
        }).catch(err => {
            console.error('❌ LiveKit connection failed:', err);
            throw err; // rethrow so the catch block handles it
        });

        // Add timeout to detect hanging connections
        const timeoutPromise = new Promise((_, reject) => {
            setTimeout(() => reject(new Error('Connection timeout after 10 seconds')), 10000);
        });

        await Promise.race([connectPromise, timeoutPromise]);
        console.log('🎉 LiveKit connection promise resolved');

        // Check if we're connected but the event didn't fire
        if (livekitRoom.state === LiveKit.ConnectionState.Connected && !livekitConnected) {
            console.log('⚠️ Connection state is Connected but event didn\'t fire, manually triggering...');
            livekitConnected = true;
            handleLiveKitConnected(livekitRoom, screenStream, examInfo);
        } else {
            if (!livekitRoom) {
                console.error('❌ livekitRoom is undefined — connection may have failed.');
                return;
            }

            console.log('📊 Connection state after connect:', livekitRoom.state || '(unknown)');
            console.log('📊 Local participant available:', !!livekitRoom.localParticipant);
            console.log('📊 Room participants count:', livekitRoom.participants?.size ?? 0);

            if (livekitRoom.state === LiveKit.ConnectionState.Disconnected) {
                console.error('❌ LiveKit connection state is Disconnected — check URL or token.');
                return;
            }

            if (livekitRoom.localParticipant && !livekitConnected) {
                console.log('⚠️ Local participant available but Connected event did not fire. Triggering manually...');
                livekitConnected = true;
                handleLiveKitConnected(livekitRoom, screenStream, examInfo);
            }
        }

    } catch (error) {
        console.error('❌ Error connecting to LiveKit:', error);
        console.error('❌ Error details:', error.message);
        console.error('❌ Error stack:', error.stack);
    }
};

// 📹 Separate function for camera sharing
const shareCameraFeed = async (room) => {
    try {
        console.log('📹 Setting up camera feed...');

        // Get camera stream with reduced quality
        const cameraStream = await navigator.mediaDevices.getUserMedia({
            video: {
                width: { ideal: 320, max: 640 },
                height: { ideal: 240, max: 480 },
                frameRate: { ideal: 10, max: 15 }
            },
            audio: false // We'll handle audio separately if needed
        });

        console.log('📹 Camera stream obtained:', {
            id: cameraStream.id,
            active: cameraStream.active,
            trackCount: cameraStream.getTracks().length
        });

        // Extract camera video track
        const cameraVideoTracks = cameraStream.getVideoTracks();
        if (cameraVideoTracks.length > 0) {
            const cameraMediaStreamTrack = cameraVideoTracks[0];

            // Create LiveKit camera track
            const cameraTrack = new LiveKit.LocalVideoTrack(cameraMediaStreamTrack, {
                name: 'camera',
            });

            // Set camera source
            cameraTrack.source = LiveKit.Track.Source.Camera;

            // Publish camera track with reduced quality
            const cameraPublication = await room.localParticipant.publishTrack(cameraTrack, {
                simulcast: false, // Disable simulcast for lower bandwidth
                videoEncoding: {
                    maxBitrate: 200000, // 200 kbps for camera (very low bandwidth)
                    maxFramerate: 10
                }
            });

            console.log('✅ Camera feed published successfully at reduced quality (240p, 200kbps).');
            console.log('📊 Camera publication details:', {
                trackSid: cameraPublication.trackSid,
                trackName: cameraPublication.trackName,
                source: cameraPublication.source,
                simulcast: cameraPublication.simulcast,
            });

            // Store camera stream for cleanup
            room.cameraStream = cameraStream;
            return cameraTrack;
        }
    } catch (cameraError) {
        console.warn('⚠️ Could not set up camera feed:', cameraError.message);
        console.log('ℹ️ Continuing without camera feed...');
        return null;
    }
};

// 🖥️ Separate function for screen sharing
const shareScreenFeed = async (room, screenStream) => {
    try {
        console.log('🖥️ Setting up screen sharing...');

        // Log screen stream details
        console.log('🎥 Screen stream details:', {
            id: screenStream.id,
            active: screenStream.active,
            trackCount: screenStream.getTracks().length
        });

        console.log('🔍 All tracks in screen stream:', screenStream.getTracks().map(track => ({
            kind: track.kind,
            label: track.label,
            enabled: track.enabled,
            readyState: track.readyState
        })));

        // Extract the video track from the existing screen stream
        console.info("MMMM ", screenStream)
        const videoTracks = screenStream.getVideoTracks();
        if (videoTracks.length === 0) {
            throw new Error('No video tracks available in screen stream');
        }
        const mediaStreamTrack = videoTracks[0];

        // Wrap it in a LiveKit LocalVideoTrack (and mark it as screen share)
        const screenTrack = new LiveKit.LocalVideoTrack(mediaStreamTrack, {
            name: 'screen-share',
        });

        // Override its source for clarity
        screenTrack.source = LiveKit.Track.Source.ScreenShare;

        // Publish the screen share track
        const publication = await room.localParticipant.publishTrack(screenTrack, {
            simulcast: false, // Screen sharing typically doesn't need simulcast
            videoEncoding: {
                maxBitrate: 1000000, // 1 Mbps for 540p
                maxFramerate: 15
            }
        });

        console.log('✅✅✅✅✅ Created and published LiveKit LocalVideoTrack from screen stream at 540p quality.', screenTrack);

        console.log('✅ Screen share published successfully.');
        console.log('📊 Screen share publication details:', {
            trackSid: publication.trackSid,
            trackName: publication.trackName,
            source: publication.source,
            simulcast: publication.simulcast,
        });

        return screenTrack;
    } catch (error) {
        console.error('❌ Error setting up screen sharing:', error);
        throw error;
    }
};

const handleLiveKitConnected = async (room, screenStream, examInfo) => {
    try {
        console.log('🎯 Setting up LiveKit streams based on exam requirements...');
        console.log('📺 Screen stream available:', !!screenStream);
        console.log('📋 Exam requirements:', {
            shareScreen: examInfo?.shareScreen,
            camera: examInfo?.camera
        });

        // Disable microphone (not needed for screen sharing)
        await room.localParticipant.setMicrophoneEnabled(false);
        console.log('🔇 Microphone disabled');

        let cameraTrack = null;
        let screenTrack = null;

        // 📹 FIRST: Share camera feed (if required)
        if (examInfo?.camera) {
            console.log('🚀 Starting with camera feed first...');
            cameraTrack = await shareCameraFeed(room);
        } else {
            console.log('ℹ️ Camera feed not required for this exam');
        }

        // 🖥️ SECOND: Share screen feed (if required)
        if (examInfo?.shareScreen) {
            console.log('🚀 Now sharing screen feed...');
            screenTrack = await shareScreenFeed(room, screenStream);
        } else {
            console.log('ℹ️ Screen sharing not required for this exam');
        }

        console.log('🎉 Stream setup completed!');
        console.log('📊 Active tracks:', {
            camera: cameraTrack ? '✅ Active' : '❌ Not required',
            screen: screenTrack ? '✅ Active' : '❌ Not required'
        });

        // Show LiveKit room UI and render the participant
        // showLiveKitRoom();
        // renderLocalParticipant(room.localParticipant, screenTrack, cameraTrack);

    } catch (error) {
        console.error('❌ Error setting up LiveKit streams:', error);
        console.error('❌ Error message:', error.message);
        console.error('❌ Error stack:', error.stack);
    }
};


const handleLiveKitDisconnected = () => {
    console.log('🔄 LiveKit disconnected, cleaning up...');
    hideLiveKitRoom();
    livekitRoom = null;
    livekitConnected = false;
};

const showLiveKitRoom = () => {
    const livekitContainer = document.getElementById('livekit-room');
    if (livekitContainer) {
        livekitContainer.style.display = 'block';
    }
};

const hideLiveKitRoom = () => {
    const livekitContainer = document.getElementById('livekit-room');
    if (livekitContainer) {
        livekitContainer.style.display = 'none';
    }
    // Clear participants
    const participantsContainer = document.getElementById('livekit-participants');
    if (participantsContainer) {
        participantsContainer.innerHTML = '';
    }
    // Clear local participant container
    const localContainer = document.getElementById('local-participant-container');
    if (localContainer) {
        localContainer.remove();
    }
};

const renderParticipant = (participant) => {
    const container = document.getElementById('livekit-participants');
    if (!container) return;

    const participantDiv = document.createElement('div');
    participantDiv.id = `participant-${participant.identity}`;
    participantDiv.style.cssText = `
        width: 300px;
        height: 200px;
        background: #024565;
        border-radius: 8px;
        position: relative;
        overflow: hidden;
        border: 2px solid #93ba49;
    `;

    const nameDiv = document.createElement('div');
    nameDiv.textContent = participant.identity;
    nameDiv.style.cssText = `
        position: absolute;
        bottom: 0;
        left: 0;
        right: 0;
        background: rgba(0,0,0,0.7);
        color: white;
        padding: 5px;
        font-size: 12px;
    `;

    participantDiv.appendChild(nameDiv);
    container.appendChild(participantDiv);
};

const renderLocalParticipant = (participant, screenTrack, cameraTrack) => {
    const container = document.getElementById('livekit-participants');
    if (!container) return;

    // Create container for local participant
    const localContainer = document.createElement('div');
    localContainer.id = `local-participant-container`;
    localContainer.style.cssText = `
        display: flex;
        gap: 10px;
        margin-bottom: 10px;
    `;

    // Screen Share Video
    const screenDiv = document.createElement('div');
    screenDiv.id = `participant-${participant.identity}-screen`;
    screenDiv.style.cssText = `
        width: 300px;
        height: 200px;
        background: #024565;
        border-radius: 8px;
        position: relative;
        overflow: hidden;
        border: 2px solid #93ba49;
    `;

    const screenNameDiv = document.createElement('div');
    screenNameDiv.textContent = `${participant.identity} (Screen Share)`;
    screenNameDiv.style.cssText = `
        position: absolute;
        bottom: 0;
        left: 0;
        right: 0;
        background: rgba(0,0,0,0.7);
        color: white;
        padding: 5px;
        font-size: 12px;
    `;

    // Create video element for screen share
    const screenVideoElement = document.createElement('video');
    screenVideoElement.autoplay = true;
    screenVideoElement.playsInline = true;
    screenVideoElement.style.cssText = `
        width: 100%;
        height: 100%;
        object-fit: cover;
    `;

    // Attach the screen track to the video element
    console.log('🎥 Attaching screen track to video element:', {
        trackName: screenTrack.name,
        source: screenTrack.source,
        kind: screenTrack.kind,
        enabled: screenTrack.enabled,
        mediaStreamTrackLabel: screenTrack.mediaStreamTrack?.label
    });
    screenTrack.attach(screenVideoElement);

    // Add event listener to see when video loads
    screenVideoElement.addEventListener('loadedmetadata', () => {
        console.log('🎥 Screen video loaded metadata:', {
            videoWidth: screenVideoElement.videoWidth,
            videoHeight: screenVideoElement.videoHeight,
            srcObject: !!screenVideoElement.srcObject
        });
    });

    screenDiv.appendChild(screenVideoElement);
    screenDiv.appendChild(screenNameDiv);

    // Camera Video
    const cameraDiv = document.createElement('div');
    cameraDiv.id = `participant-${participant.identity}-camera`;
    cameraDiv.style.cssText = `
        width: 200px;
        height: 150px;
        background: #024565;
        border-radius: 8px;
        position: relative;
        overflow: hidden;
        border: 2px solid #93ba49;
    `;

    const cameraNameDiv = document.createElement('div');
    cameraNameDiv.textContent = `${participant.identity} (Camera)`;
    cameraNameDiv.style.cssText = `
        position: absolute;
        bottom: 0;
        left: 0;
        right: 0;
        background: rgba(0,0,0,0.7);
        color: white;
        padding: 5px;
        font-size: 12px;
    `;

    // Create video element for camera
    const cameraVideoElement = document.createElement('video');
    cameraVideoElement.autoplay = true;
    cameraVideoElement.playsInline = true;
    cameraVideoElement.style.cssText = `
        width: 100%;
        height: 100%;
        object-fit: cover;
    `;

    // Attach the camera track to the video element
    if (cameraTrack) {
        console.log('📹 Attaching camera track to video element:', {
            trackName: cameraTrack.name,
            source: cameraTrack.source,
            kind: cameraTrack.kind,
            enabled: cameraTrack.enabled,
            mediaStreamTrackLabel: cameraTrack.mediaStreamTrack?.label
        });
        cameraTrack.attach(cameraVideoElement);

        // Add event listener to see when video loads
        cameraVideoElement.addEventListener('loadedmetadata', () => {
            console.log('📹 Camera video loaded metadata:', {
                videoWidth: cameraVideoElement.videoWidth,
                videoHeight: cameraVideoElement.videoHeight,
                srcObject: !!cameraVideoElement.srcObject
            });
        });
    }

    cameraDiv.appendChild(cameraVideoElement);
    cameraDiv.appendChild(cameraNameDiv);

    // Add videos to container (only screen share if camera is disabled)
    localContainer.appendChild(screenDiv);
    if (cameraTrack) {
        localContainer.appendChild(cameraDiv);
        console.log('✅ Local participant videos rendered (screen + camera)');
    } else {
        console.log('✅ Local participant video rendered (screen only)');
    }
    container.appendChild(localContainer);
};

const removeParticipant = (identity) => {
    const participantDiv = document.getElementById(`participant-${identity}`);
    if (participantDiv) {
        participantDiv.remove();
    }
};

const renderTrack = (track, participant) => {
    const participantDiv = document.getElementById(`participant-${participant.identity}`);
    if (!participantDiv) return;

    if (track.kind === 'video') {
        const videoElement = document.createElement('video');
        videoElement.autoplay = true;
        videoElement.playsInline = true;
        videoElement.style.cssText = `
            width: 100%;
            height: 100%;
            object-fit: cover;
        `;

        // Remove existing video element if any
        const existingVideo = participantDiv.querySelector('video');
        if (existingVideo) {
            existingVideo.remove();
        }

        participantDiv.insertBefore(videoElement, participantDiv.firstChild);
        track.attach(videoElement);
    }
};

const removeTrack = (track, participant) => {
    const participantDiv = document.getElementById(`participant-${participant.identity}`);
    if (!participantDiv) return;

    if (track.kind === 'video') {
        const videoElement = participantDiv.querySelector('video');
        if (videoElement) {
            track.detach(videoElement);
            videoElement.remove();
        }
    }
};

const disconnectFromLiveKit = async () => {
    if (livekitRoom && livekitConnected) {
        try {
            console.log('🔌 Disconnecting from LiveKit...');

            // Stop camera stream if it exists
            if (livekitRoom.cameraStream) {
                console.log('📹 Stopping camera stream...');
                livekitRoom.cameraStream.getTracks().forEach(track => track.stop());
                livekitRoom.cameraStream = null;
            }

            await livekitRoom.disconnect();
        } catch (error) {
            console.error('❌ Error disconnecting from LiveKit:', error);
        }
    }
};

stopShareBtn.addEventListener('click', async () => {
    if (stream) {
        if (uploadInterval) {
            clearInterval(uploadInterval);
            uploadInterval = null;
        }
        // Disconnect from LiveKit first (this will also stop camera stream)
        // await disconnectFromLiveKit();

        // Stop screen sharing stream
        stream.getTracks().forEach(track => track.stop())
        stream = null
        // screenView.srcObject = null
        body.classList.remove('screen-sharing-active')
        shareScreenBtn.disabled = false
        stopShareBtn.disabled = true
        console.log('Screen sharing and camera feed stopped manually')
    }
})

// Close LiveKit room button
document.getElementById('closeLivekit').addEventListener('click', async () => {
    // await disconnectFromLiveKit();
});

document.getElementById('exitApp').addEventListener('click', async () => {
    try {
        const response = await window.electronAPI.showDialog({
            message: 'Are you sure you want to quit?'
        })

        if (response === 0) { // User clicked OK
            // Send audit log if in an exam
            if (currentExamData.sqid) {
                sendAuditLog('App exited during exam by user click');
            }
            window.electronAPI.quitApp()
        }
    } catch (error) {
        console.error('Dialog error:', error)
        if (confirm('Are you sure you want to quit?')) {
            // Send audit log if in an exam
            if (currentExamData.sqid) {
                sendAuditLog('App exited during exam by user click');
            }
            window.electronAPI.quitApp()
        }
    }
})
// window.electronAPI.onQuizData((data) => {
//   const { quizId, userId } = data;
//   const uuid = crypto.randomUUID();
//   const iframe = document.getElementById('lmsFrame');
//   const quizUrl = `http://localhost:3000/e-quiz/${quizId}/${uuid}`;
//   console.info(quizUrl)
//   iframe.src = quizUrl;
// });

// === Disable Tab Key and Text Selection ===
// Disable Tab key globally (including inside iframes)
function disableTabKey() {
    // Global keydown listener to catch Tab key before it reaches iframe
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Tab' || e.keyCode === 9) {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            return false;
        }
    }, true); // Use capture phase to catch before iframe

    // Also listen on window level
    window.addEventListener('keydown', (e) => {
        if (e.key === 'Tab' || e.keyCode === 9) {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            return false;
        }
    }, true);

    // Try to disable Tab in iframe if same-origin
    const iframe = document.getElementById('lmsFrame');
    if (iframe) {
        iframe.addEventListener('load', () => {
            try {
                const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
                if (iframeDoc) {
                    iframeDoc.addEventListener('keydown', (e) => {
                        if (e.key === 'Tab' || e.keyCode === 9) {
                            e.preventDefault();
                            e.stopPropagation();
                            return false;
                        }
                    }, true);

                    // Also disable text selection in iframe
                    iframeDoc.addEventListener('selectstart', (e) => {
                        e.preventDefault();
                        return false;
                    });
                    iframeDoc.addEventListener('mousedown', (e) => {
                        if (e.detail > 1) { // Double click
                            e.preventDefault();
                        }
                    });
                }
            } catch (e) {
                // Cross-origin iframe - can't access content
                console.log('Iframe is cross-origin, using global handlers only');
            }
        });
    }
}

// Disable text selection globally
function disableTextSelection() {
    // Prevent text selection events
    document.addEventListener('selectstart', (e) => {
        e.preventDefault();
        return false;
    });

    document.addEventListener('dragstart', (e) => {
        e.preventDefault();
        return false;
    });

    // Prevent context menu (right-click)
    document.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        return false;
    });

    // Prevent double-click selection
    document.addEventListener('mousedown', (e) => {
        if (e.detail > 1) { // Double click
            e.preventDefault();
        }
    });

    // Also on window level
    window.addEventListener('selectstart', (e) => {
        e.preventDefault();
        return false;
    });

    window.addEventListener('dragstart', (e) => {
        e.preventDefault();
        return false;
    });
}

// === Multiple Display Alert Management ===
let multipleDisplayAlert = null;

// === SweetAlert Handlers ===
// Ensure Swal is available from window (loaded from local file)
const getSwal = () => {
    if (typeof window !== 'undefined' && window.Swal) {
        return window.Swal;
    }
    console.error('SweetAlert2 is not available. Make sure sweetalert2.all.min.js is loaded.');
    return null;
};

// Wait for Swal to be available before setting up handlers
let swalRetryCount = 0;
const MAX_SWAL_RETRIES = 50; // 5 seconds max wait time

const setupSweetAlertHandlers = () => {
    if (!window.Swal) {
        swalRetryCount++;
        if (swalRetryCount < MAX_SWAL_RETRIES) {
            // Wait a bit and try again
            setTimeout(setupSweetAlertHandlers, 100);
            return;
        } else {
            console.error('SweetAlert2 failed to load after multiple attempts. Check if sweetalert2.all.min.js is included in the build.');
            return;
        }
    }
    
    console.log('SweetAlert2 loaded successfully, setting up handlers');

    if (window.electronAPI && window.electronAPI.onShowSweetAlertWarning) {
        window.electronAPI.onShowSweetAlertWarning(async (options) => {
            const Swal = getSwal();
            if (!Swal) {
                console.error('Cannot show SweetAlert: Swal is not defined');
                return;
            }
            const result = await Swal.fire({
                title: options.title || 'Warning',
                text: options.text || '',
                icon: options.icon || 'warning',
                confirmButtonText: options.confirmButtonText || 'OK',
                allowOutsideClick: options.allowOutsideClick !== false,
                allowEscapeKey: options.allowEscapeKey !== false,
                backdrop: true,
                focusConfirm: true
            });
            
            // Send audit log when Windows/Command key warning is shown
            sendAuditLog('Windows/Command key pressed - unauthorized action detected');
            
            // Request window state restoration
            if (window.electronAPI && window.electronAPI.restoreWindowState) {
                window.electronAPI.restoreWindowState();
            }
        });
    }

    if (window.electronAPI && window.electronAPI.onShowSweetAlertConfirm) {
        window.electronAPI.onShowSweetAlertConfirm(async (options) => {
            // Don't show exit dialog if multiple display alert is showing
            if (multipleDisplayAlert) {
                console.log('Exit dialog blocked: Multiple display alert is showing');
                // Send cancel response
                if (window.electronAPI && window.electronAPI.sendSweetAlertConfirmResponse) {
                    window.electronAPI.sendSweetAlertConfirmResponse(false);
                }
                return;
            }
            
            const Swal = getSwal();
            if (!Swal) {
                console.error('Cannot show SweetAlert: Swal is not defined');
                return;
            }
            const result = await Swal.fire({
                title: options.title || 'Confirm',
                text: options.text || '',
                icon: options.icon || 'question',
                showCancelButton: options.showCancelButton !== false,
                confirmButtonText: options.confirmButtonText || 'OK',
                cancelButtonText: options.cancelButtonText || 'Cancel',
                allowOutsideClick: options.allowOutsideClick !== false,
                allowEscapeKey: options.allowEscapeKey !== false,
                backdrop: true,
                focusConfirm: true
            });
            
            // If confirmed and it's an exit dialog, send audit log
            if (result.isConfirmed && options.title && options.title.includes('Exit')) {
                if (currentExamData.sqid) {
                    sendAuditLog('App exited during exam by exit request');
                }
            }
            
            // Send response to main process
            if (window.electronAPI && window.electronAPI.sendSweetAlertConfirmResponse) {
                window.electronAPI.sendSweetAlertConfirmResponse(result.isConfirmed);
            }
        });
    }

    if (window.electronAPI && window.electronAPI.onShowSweetAlertDialog) {
        window.electronAPI.onShowSweetAlertDialog(async (options) => {
            const Swal = getSwal();
            if (!Swal) {
                console.error('Cannot show SweetAlert: Swal is not defined');
                return;
            }
            const result = await Swal.fire({
                title: options.title || 'Confirm',
                text: options.text || '',
                icon: options.icon || 'question',
                showCancelButton: options.showCancelButton !== false,
                confirmButtonText: options.confirmButtonText || 'OK',
                cancelButtonText: options.cancelButtonText || 'Cancel',
                allowOutsideClick: false,
                allowEscapeKey: false,
                backdrop: true,
                focusConfirm: true
            });
            
            // Send response to main process
            if (window.electronAPI && window.electronAPI.sendSweetAlertResponse) {
                window.electronAPI.sendSweetAlertResponse(result.isConfirmed);
            }
        });
    }

    // Multiple display alert - non-dismissable
    if (window.electronAPI && window.electronAPI.onShowSweetAlertMultipleDisplay) {
        window.electronAPI.onShowSweetAlertMultipleDisplay(async (options) => {
            console.log('Received multiple display alert request', options);
            const Swal = getSwal();
            if (!Swal) {
                console.error('Cannot show SweetAlert: Swal is not defined, will retry');
                // Retry multiple times with increasing delays
                let retryCount = 0;
                const maxRetries = 10;
                const retryInterval = setInterval(() => {
                    retryCount++;
                    const SwalRetry = getSwal();
                    if (SwalRetry) {
                        clearInterval(retryInterval);
                        console.log('SweetAlert now available, showing alert');
                        showMultipleDisplayAlert(SwalRetry, options);
                    } else if (retryCount >= maxRetries) {
                        clearInterval(retryInterval);
                        console.error('SweetAlert failed to load after multiple retries');
                    }
                }, 500);
                return;
            }
            console.log('SweetAlert available, showing alert immediately');
            showMultipleDisplayAlert(Swal, options);
        });
    } else {
        console.warn('onShowSweetAlertMultipleDisplay handler not available');
    }

    // Helper function to show multiple display alert
    function showMultipleDisplayAlert(Swal, options) {
        // Close existing alert if any
        if (multipleDisplayAlert) {
            Swal.close();
            multipleDisplayAlert = null;
        }
        // Show non-dismissable alert
        multipleDisplayAlert = Swal.fire({
            title: options.title || 'Multiple Displays Detected',
            text: options.text || '',
            icon: options.icon || 'warning',
            showConfirmButton: false,
            showCancelButton: false,
            showCloseButton: false,
            allowOutsideClick: false,
            allowEscapeKey: false,
            allowEnterKey: false,
            backdrop: 'rgba(0,0,0,0.95)', // Very dark backdrop (95% black opacity)
            didOpen: () => {
                // Disable all keyboard shortcuts and prevent any interaction
                const container = Swal.getContainer();
                if (container) {
                    // Block all keyboard events
                    container.addEventListener('keydown', (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        e.stopImmediatePropagation();
                        return false;
                    }, true); // Use capture phase
                    
                    // Block all keyboard events on document level too
                    document.addEventListener('keydown', (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        e.stopImmediatePropagation();
                        return false;
                    }, true);
                    
                    // Block mouse clicks outside the alert
                    container.addEventListener('click', (e) => {
                        if (e.target === container || e.target.classList.contains('swal2-backdrop-show')) {
                            e.preventDefault();
                            e.stopPropagation();
                        }
                    }, true);
                }
                
                // Notify main process that alert is shown
                if (window.electronAPI && window.electronAPI.notifyMultipleDisplayAlertShown) {
                    window.electronAPI.notifyMultipleDisplayAlertShown();
                    console.log('Notified main process that alert is shown');
                }
            },
            willClose: () => {
                // Prevent closing - only allow programmatic close
                if (multipleDisplayAlert) {
                    // Only allow close if explicitly requested (display count = 1)
                    // This prevents accidental closes
                    return false;
                }
            }
        });
        
        // Prevent the alert from being closed by any means
        // Monitor for close attempts and immediately reopen
        const preventClose = setInterval(() => {
            if (multipleDisplayAlert && Swal.isVisible() === false) {
                // Alert was closed, reopen it immediately
                console.warn('Multiple display alert was closed, reopening...');
                multipleDisplayAlert = Swal.fire({
                    title: options.title || 'Multiple Displays Detected',
                    text: options.text || '',
                    icon: options.icon || 'warning',
                    showConfirmButton: false,
                    showCancelButton: false,
                    showCloseButton: false,
                    allowOutsideClick: false,
                    allowEscapeKey: false,
                    allowEnterKey: false,
                    backdrop: 'rgba(0,0,0,0.95)', // Very dark backdrop (95% black opacity)
                    didOpen: () => {
                        const container = Swal.getContainer();
                        if (container) {
                            container.addEventListener('keydown', (e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                e.stopImmediatePropagation();
                                return false;
                            }, true);
                            document.addEventListener('keydown', (e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                e.stopImmediatePropagation();
                                return false;
                            }, true);
                        }
                    }
                });
            }
        }, 100);
        
        // Store the interval so we can clear it when display count becomes 1
        if (!window._multipleDisplayAlertInterval) {
            window._multipleDisplayAlertInterval = preventClose;
        }
        console.log('Multiple display alert shown');
    }

    // Close multiple display alert
    if (window.electronAPI && window.electronAPI.onCloseMultipleDisplayAlert) {
        window.electronAPI.onCloseMultipleDisplayAlert(() => {
            console.log('Received close multiple display alert request');
            const Swal = getSwal();
            if (Swal && multipleDisplayAlert) {
                // Clear the interval that prevents closing
                if (window._multipleDisplayAlertInterval) {
                    clearInterval(window._multipleDisplayAlertInterval);
                    window._multipleDisplayAlertInterval = null;
                }
                Swal.close();
                multipleDisplayAlert = null;
                // Notify main process that alert is closed
                if (window.electronAPI && window.electronAPI.notifyMultipleDisplayAlertClosed) {
                    window.electronAPI.notifyMultipleDisplayAlertClosed();
                }
                console.log('Multiple display alert closed');
            }
        });
    }
};

// Set up handlers immediately (don't wait for DOMContentLoaded)
// This ensures handlers are ready before IPC messages arrive
if (window.electronAPI) {
    console.log('Setting up SweetAlert handlers immediately');
    setupSweetAlertHandlers();
} else {
    console.warn('electronAPI not available yet, will retry');
    // Retry when electronAPI becomes available
    const checkElectronAPI = setInterval(() => {
        if (window.electronAPI) {
            clearInterval(checkElectronAPI);
            console.log('electronAPI now available, setting up handlers');
            setupSweetAlertHandlers();
        }
    }, 100);
    
    // Stop checking after 5 seconds
    setTimeout(() => {
        clearInterval(checkElectronAPI);
    }, 5000);
}

// Also set up on DOMContentLoaded as backup
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        // Handlers already set up, but verify
        if (window.electronAPI && !window.electronAPI.onShowSweetAlertMultipleDisplay) {
            console.log('Re-setting up SweetAlert handlers on DOMContentLoaded');
            setupSweetAlertHandlers();
        }
    });
}

// === Status Bar Management ===
let batteryUpdateInterval = null;
let networkUpdateInterval = null;
let timeUpdateInterval = null;

// Update time display
function updateTime() {
    const timeElement = document.getElementById('timeText');
    if (timeElement) {
        const now = new Date();
        const hours = String(now.getHours()).padStart(2, '0');
        const minutes = String(now.getMinutes()).padStart(2, '0');
        timeElement.textContent = `${hours}:${minutes}`;
    }
}

// Update battery status
async function updateBatteryStatus() {
    const batteryElement = document.getElementById('batteryStatus');
    const batteryText = document.getElementById('batteryText');
    
    if (!batteryElement || !batteryText) return;
    
    try {
        // Use Battery API if available
        if ('getBattery' in navigator) {
            const battery = await navigator.getBattery();
            const level = Math.round(battery.level * 100);
            const charging = battery.charging;
            
            batteryText.textContent = `${level}%`;
            
            // Update styling based on battery level and charging status
            batteryElement.classList.remove('low', 'charging');
            if (charging) {
                batteryElement.classList.add('charging');
            } else if (level <= 20) {
                batteryElement.classList.add('low');
            }
        } else {
            // Fallback if Battery API not available
            batteryText.textContent = 'N/A';
        }
    } catch (error) {
        console.error('Error updating battery status:', error);
        batteryText.textContent = 'N/A';
    }
}

// Update network status
function updateNetworkStatus() {
    const networkElement = document.getElementById('networkStatus');
    const networkText = document.getElementById('networkText');
    
    if (!networkElement || !networkText) return;
    
    const online = navigator.onLine;
    
    if (online) {
        networkText.textContent = 'Online';
        networkElement.classList.remove('offline');
    } else {
        networkText.textContent = 'Offline';
        networkElement.classList.add('offline');
    }
}

// Initialize status bar
function initializeStatusBar() {
    // Update time immediately and then every minute
    updateTime();
    timeUpdateInterval = setInterval(updateTime, 60000); // Update every minute
    
    // Update battery status immediately and then every 30 seconds
    updateBatteryStatus();
    batteryUpdateInterval = setInterval(updateBatteryStatus, 30000); // Update every 30 seconds
    
    // Update network status immediately and then every 5 seconds
    updateNetworkStatus();
    networkUpdateInterval = setInterval(updateNetworkStatus, 5000); // Update every 5 seconds
    
    // Listen for online/offline events
    window.addEventListener('online', updateNetworkStatus);
    window.addEventListener('offline', updateNetworkStatus);
    
    // Listen for battery charging change events
    if ('getBattery' in navigator) {
        navigator.getBattery().then(battery => {
            battery.addEventListener('chargingchange', updateBatteryStatus);
            battery.addEventListener('levelchange', updateBatteryStatus);
        });
    }
}

// === On DOM Content Load ===
document.addEventListener('DOMContentLoaded', () => {
    const iframe = document.getElementById('lmsFrame');
    console.info("DOMContentLoaded");
    
    // Verify SweetAlert handlers are set up
    if (window.electronAPI && window.electronAPI.onShowSweetAlertMultipleDisplay) {
        console.log('SweetAlert handlers verified on DOMContentLoaded');
    } else {
        console.warn('SweetAlert handlers not found, re-setting up');
        setupSweetAlertHandlers();
    }
    
    // Initialize status bar
    initializeStatusBar();
    
    // Handle exit audit log request from main process
    if (window.electronAPI && window.electronAPI.onSendExitAuditLog) {
        window.electronAPI.onSendExitAuditLog(() => {
            if (currentExamData.sqid) {
                sendAuditLog('App exited during exam by exit request');
            }
        });
    }

    // Disable Tab key and text selection
    disableTabKey();
    disableTextSelection();

    const quizUrl = CONFIG.BASE_LANDING; // should be something like './landing.html'
    console.info('Loading:', quizUrl);
    iframe.src = quizUrl;

    // Test IPC communication
    console.log('🔧 Testing IPC communication...');
    console.log('🔧 electronAPI available:', !!window.electronAPI);
    console.log('🔧 onLaunchData function available:', !!window.electronAPI?.onLaunchData);

    // Test message handler
    if (window.electronAPI && window.electronAPI.onTestMessage) {
        window.electronAPI.onTestMessage((message) => {
            console.log('🧪 Test message received:', message);
        });
    }
});

// === On Launch Data from Electron ===
window.electronAPI.onLaunchData(async (data) => {
    console.info("🚀 onLaunchData received!");
    console.log('📊 Got launch data:', data);

    const { quizId, studentId, tkn, sqid, examType } = data;
    console.log('📋 Extracted parameters:', { quizId, studentId, tkn: tkn?.substring(0, 20) + '...', sqid, examType, examTypeType: typeof examType });
    console.log('📋 Full data object:', JSON.stringify(data, null, 2));

    // Store exam data for audit logging
    currentExamData = {
        sqid: sqid
    };

    const iframe = document.getElementById('lmsFrame');
    const errorMessage = document.getElementById('lmsError');
    
    // Hide error message initially
    if (errorMessage) {
        errorMessage.style.display = 'none';
    }
    
    // Use resit-preview if examType is 'resit', otherwise use exam-preview
    const normalizedExamType = examType ? String(examType).trim().toLowerCase() : 'exam';
    const previewPath = normalizedExamType === 'resit' ? 'resit-preview' : 'exam-preview';
    const examUrl = `${CONFIG.BASE_LMS_URL}/${previewPath}/${quizId}/${tkn}/${studentId}/${sqid}`;
    console.log('🌐 Loading exam URL:', examUrl);

    // Set up error handling for iframe
    let loadTimeout;
    let hasLoaded = false;

    // Handle successful load
    const handleLoad = () => {
        hasLoaded = true;
        if (loadTimeout) {
            clearTimeout(loadTimeout);
        }
        if (errorMessage) {
            errorMessage.style.display = 'none';
        }
    };

    // Handle load error with timeout
    const handleError = () => {
        if (!hasLoaded && errorMessage) {
            errorMessage.style.display = 'block';
            iframe.style.display = 'none';
        }
    };

    // Set timeout to detect connection errors (5 seconds)
    loadTimeout = setTimeout(() => {
        if (!hasLoaded) {
            console.error('❌ Iframe load timeout - LMS connection failed');
            handleError();
        }
    }, 5000);

    // Re-apply Tab key blocking when iframe loads new content
    iframe.addEventListener('load', () => {
        handleLoad();
        try {
            const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
            if (iframeDoc) {
                iframeDoc.addEventListener('keydown', (e) => {
                    if (e.key === 'Tab' || e.keyCode === 9) {
                        e.preventDefault();
                        e.stopPropagation();
                        return false;
                    }
                }, true);

                // Also disable text selection in iframe
                iframeDoc.addEventListener('selectstart', (e) => {
                    e.preventDefault();
                    return false;
                });
                iframeDoc.addEventListener('mousedown', (e) => {
                    if (e.detail > 1) { // Double click
                        e.preventDefault();
                    }
                });
            }
        } catch (e) {
            // Cross-origin iframe - can't access content
            console.log('Iframe is cross-origin, using global handlers only');
        }
    }, { once: true });

    // Listen for iframe error events
    iframe.addEventListener('error', (e) => {
        console.error('❌ Iframe error event:', e);
        handleError();
    });

    // Try to detect connection errors by checking iframe content
    // Note: This may not work for cross-origin iframes due to CORS
    iframe.addEventListener('load', () => {
        // Additional check after load - verify if we can access the content
        setTimeout(() => {
            try {
                // Try to access iframe content to verify it loaded
                const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
                if (!iframeDoc || iframeDoc.location.href === 'about:blank') {
                    console.error('❌ Iframe appears to have failed loading');
                    handleError();
                }
            } catch (e) {
                // Cross-origin - can't check, assume it loaded if we got here
                console.log('Cannot verify iframe content (cross-origin), assuming loaded');
            }
        }, 1000);
    }, { once: true });

    // Listen for connection errors from main process
    if (window.electronAPI && window.electronAPI.onLmsConnectionError) {
        window.electronAPI.onLmsConnectionError((data) => {
            console.error('❌ LMS connection error received from main process:', data);
            handleError();
        });
    }

    // Override console.error to catch ERR_CONNECTION_REFUSED
    const originalConsoleError = console.error;
    console.error = function(...args) {
        originalConsoleError.apply(console, args);
        const errorMessage = args.join(' ');
        if (errorMessage.includes('ERR_CONNECTION_REFUSED') || 
            errorMessage.includes('Failed to load URL') ||
            errorMessage.includes('net::ERR_CONNECTION_REFUSED')) {
            console.log('🔍 Detected connection error in console');
            handleError();
        }
    };

    iframe.src = examUrl;

    // Send audit log when exam opens
    sendAuditLog('Exam opened from ProctorX URL');

    console.log('🔍 Getting exam info...');
    const examInfo = await getExamInfo(quizId, tkn, examType); // ✅ await here
    if (examInfo) {
        console.log('📺 Exam requirements:', {
            shareScreen: examInfo.shareScreen,
            camera: examInfo.camera
        });

        if (examInfo.shareScreen || examInfo.camera) {
            console.log('👤 Getting student info...');
            getStudentInfo(studentId, tkn, quizId, examInfo, sqid);
        } else {
            console.log('ℹ️ No screen sharing or camera required for this exam');
        }
    } else {
        console.log('❌ Could not get exam info');
    }
});


const getStudentInfo = async (spid, tkn, quizId, examInfo, sqid) => {
    try {
        const response = await fetch(`${CONFIG.BASE_API_URL}/vle/student/get-login/${spid}`, {
            method: 'POST',
            headers: {
                'Authorization': 'Bearer ' + tkn
            }
        });

        if (!response.ok) {
            throw new Error(`API error: ${response.status} ${response.statusText}`);
        }

        const res = await response.json();
        console.log('👤 Student login response:', res);
        const userData = res.data;
        console.log('👤 User data:', userData);

        // Check what property holds the token
        if (!userData.message) {
            console.warn('⚠️ userData.message is undefined. Available keys:', Object.keys(userData));
        }

        const userToken = "Bearer " + res.message;
        console.log('🔑 Generated user token:', userToken);

        localStorage.setItem('user_token', userToken);
        localStorage.setItem('user_details', JSON.stringify(userData));
        localStorage.setItem('ws_token', userData.wsToken);

        openScreenShare(quizId, examInfo, sqid);
    } catch (error) {
        console.error('Error calling login API:', error);
    }
}

const getExamInfo = async (qid, tkn, examType = 'exam') => {
    try {
        // Use resit endpoint if examType is 'resit', otherwise use exam endpoint
        // Normalize examType: trim whitespace and convert to lowercase for comparison
        const normalizedExamType = examType ? String(examType).trim().toLowerCase() : 'exam';
        console.log('🔍 getExamInfo called with:', { qid, examType, normalizedExamType, examTypeType: typeof examType });
        const endpoint = normalizedExamType === 'resit' ? 'resit' : 'exam';
        const apiUrl = `${CONFIG.BASE_API_URL}/vle/quiz/${endpoint}/${qid}`;
        console.log('🌐 Calling API:', apiUrl);
        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: {
                'Authorization': 'Bearer ' + tkn
            }
        });

        if (!response.ok) {
            throw new Error(`API error: ${response.status} ${response.statusText}`);
        }

        const res = await response.json();
        const exam = res.data;

        console.log('📋 Exam configuration:', {
            id: exam.id,
            shareScreen: exam.shareScreen,
            camera: exam.camera,
            qname: exam.qname
        });

        return exam; // Return full exam data instead of just boolean
    } catch (error) {
        console.error('Error calling exam info API:', error);
        return null;
    }
}

function dataURLtoBlob(dataurl) {
    var arr = dataurl.split(','), mime = arr[0].match(/:(.*?);/)[1],
        bstr = atob(arr[1]), n = bstr.length, u8arr = new Uint8Array(n);
    while (n--) {
        u8arr[n] = bstr.charCodeAt(n);
    }
    return new Blob([u8arr], { type: mime });
}

const uploadScreenCapture = async (sqid) => {
    // console.log('📸 uploadScreenCapture called with sqid:', sqid);

    if (!stream) {
        // console.log('❌ No stream available');
        return;
    }

    if (!stream.active) {
        // console.log('❌ Stream is not active');
        return;
    }

    const iframe = document.getElementById('lmsFrame');
    if (!iframe) {
        // console.log('❌ iframe not found');
        return;
    }

    let currentUrl = iframe.src;
    try {
        // Try to get the actual current URL of the iframe (if same origin or allowed)
        if (iframe.contentWindow && iframe.contentWindow.location && iframe.contentWindow.location.href) {
            currentUrl = iframe.contentWindow.location.href;
        }
    } catch (e) {
        console.log('⚠️ Could not access iframe internal location (likely CORS):', e.message);
    }

    // console.log('🔗 Current iframe URL (checked):', currentUrl);

    const allowedPhrases = [
        '/e-quiz/56565f34-9e79-4f6e-972e-0aefbfcc111e/',
        '/e-pdf/56565f34-9e79-4f6e-972e-0aefbfcc111e/',
         '/r-pdf/56565f34-9e79-4f6e-972e-0aefbfcc111e/'
    ];

    const shouldUpload = allowedPhrases.some(phrase => currentUrl.includes(phrase));
    // console.log('❓ Should upload?', shouldUpload);

    if (!shouldUpload) {
        // console.log('⏭️ Skipping upload - URL does not match allowed phrases');
        return;
    }

    try {
        // console.log('🎥 Capturing frame from stream...');
        const video = document.createElement('video');
        video.autoplay = true;
        video.muted = true;
        video.srcObject = stream;
        await video.play();

        const canvas = document.createElement('canvas');
        const scaleFactor = 1.55;
        canvas.width = video.videoWidth * scaleFactor;
        canvas.height = video.videoHeight * scaleFactor;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

        const dataUrl = canvas.toDataURL('image/webp');
        // console.log('🖼️ Frame captured, data URL length:', dataUrl.length);

        const blob = dataURLtoBlob(dataUrl);
        // console.log('📦 Blob created, size:', blob.size, 'type:', blob.type);

        // Cleanup video
        video.srcObject = null;
        video.remove();

        let formData = new FormData();
        formData.append("image", blob, "frame.webp");
        formData.append("sqid", sqid + '');
        formData.append("cam",   '0');

        // console.log('🚀 Sending upload request to:', `${CONFIG.BASE_API_URL}/vle/quiz/pic`);
        const response = await fetch(`${CONFIG.EXAM_BASE_URL}/vle/quiz/pic`, {
            method: 'POST',
            headers: {
                'Authorization': localStorage.getItem('user_token')
            },
            body: formData
        });

        // console.log('✅ Upload response status:', response.status);
        if (!response.ok) {
            console.error('❌ Upload failed with status text:', response.statusText);
        } else {
            // console.log('✅ Upload successful');
        }
    } catch (e) {
        // alert('Error uploading screen capture: ' + e);
        console.error('❌ Screen upload error:', e);
    }
}