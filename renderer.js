// import * as LiveKit from 'livekit-client';

// LiveKit will be imported dynamically
import {createLocalScreenTracks, LocalVideoTrack} from "./livekit-client.esm.mjs";

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

const CONFIG = {
    BASE_API_URL: 'http://localhost:8383/api/v1',
    BASE_LMS_URL: 'http://localhost:3001',
    KURENTO: 'wss://localhost:8443/kurento-group-call/groupcall',
    BASE_LANDING: './landing.html'
};

// LiveKit Configuration
const LIVEKIT_CONFIG = {
    url: 'wss://live.codepulsesolution.com/',
    token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJ0c2xpdmVraXQiLCJleHAiOjE3NjAyMTU1MjUsInN1YiI6IjIiLCJuYW1lIjoiRCBQIEZFUk5BTkRPICgyNDEwMTAyKSIsIm1ldGFkYXRhIjoibWV0YWRhdGEiLCJ2aWRlbyI6eyJyb29tSm9pbiI6dHJ1ZSwicm9vbSI6ImRlbW9fY2xhc3MiLCJjYW5QdWJsaXNoRGF0YSI6dHJ1ZSwiY2FuUHVibGlzaCI6dHJ1ZSwiY2FuU3Vic2NyaWJlIjpmYWxzZX0sInNpcCI6e319.mVGStKfZ-sGAWkh3vgbp5x_guYY05t9RgQm9KsjMgJM',
    roomName: 'demo_class',
    participantName: 'Screen Sharer'
};

const openScreenShare = async (quizId, examInfo) => {
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

            // Disconnect from LiveKit
            await disconnectFromLiveKit();

            // Optionally, notify backend or clean up resources
            // 🔁 Restart screen sharing
            openScreenShare(quizId);
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
        await connectToLiveKit(stream, quizId, examInfo);

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
        await openScreenShare('9026', mockExamInfo);
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
                resolution: {width: 960, height: 540}
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
                width: {ideal: 320, max: 640},
                height: {ideal: 240, max: 480},
                frameRate: {ideal: 10, max: 15}
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
        background: #333;
        border-radius: 8px;
        position: relative;
        overflow: hidden;
        border: 2px solid #4CAF50;
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
        background: #333;
        border-radius: 8px;
        position: relative;
        overflow: hidden;
        border: 2px solid #FF9800;
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
        background: #333;
        border-radius: 8px;
        position: relative;
        overflow: hidden;
        border: 2px solid #2196F3;
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
        // Disconnect from LiveKit first (this will also stop camera stream)
        await disconnectFromLiveKit();

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
    await disconnectFromLiveKit();
});

document.getElementById('exitApp').addEventListener('click', async () => {
    try {
        const response = await window.electronAPI.showDialog({
            message: 'Are you sure you want to quit?'
        })

        if (response === 0) { // User clicked OK
            window.electronAPI.quitApp()
        }
    } catch (error) {
        console.error('Dialog error:', error)
        if (confirm('Are you sure you want to quit?')) {
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

// === On DOM Content Load ===
document.addEventListener('DOMContentLoaded', () => {
    const iframe = document.getElementById('lmsFrame');
    console.info("DOMContentLoaded");

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

    const {quizId, studentId, tkn, sqid} = data;
    console.log('📋 Extracted parameters:', {quizId, studentId, tkn: tkn?.substring(0, 20) + '...', sqid});

    const iframe = document.getElementById('lmsFrame');
    const examUrl = `${CONFIG.BASE_LMS_URL}/mcq-preview/${quizId}/${tkn}/${studentId}/${sqid}`;
    console.log('🌐 Loading exam URL:', examUrl);

    iframe.src = examUrl;

    console.log('🔍 Getting exam info...');
    const examInfo = await getExamInfo(quizId, tkn); // ✅ await here
    if (examInfo) {
        console.log('📺 Exam requirements:', {
            shareScreen: examInfo.shareScreen,
            camera: examInfo.camera
        });

        if (examInfo.shareScreen || examInfo.camera) {
            console.log('👤 Getting student info...');
            getStudentInfo(studentId, tkn, quizId, examInfo);
        } else {
            console.log('ℹ️ No screen sharing or camera required for this exam');
        }
    } else {
        console.log('❌ Could not get exam info');
    }
});


const getStudentInfo = async (spid, tkn, quizId, examInfo) => {
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
        const userData = res.data;

        const userToken = "Bearer " + userData.message;
        localStorage.setItem('user_token', userToken);
        localStorage.setItem('user_details', JSON.stringify(userData));
        localStorage.setItem('ws_token', userData.wsToken);

        openScreenShare(quizId, examInfo);
    } catch (error) {
        console.error('Error calling login API:', error);
    }
}

const getExamInfo = async (qid, tkn) => {
    try {
        const response = await fetch(`${CONFIG.BASE_API_URL}/vle/quiz/info/${qid}`, {
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