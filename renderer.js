const shareScreenBtn = document.getElementById('shareScreen')
const stopShareBtn = document.getElementById('stopShare')
const screenView = document.getElementById('screenView');
const exitAppBtn = document.getElementById('exitApp')
const lmsFrame = document.getElementById('lmsFrame')
const body = document.body

let stream = null

const CONFIG = {
    BASE_API_URL: 'http://localhost:8383/api/v1',
    BASE_LMS_URL: 'http://localhost:3001',
    KURENTO: 'wss://localhost:8443/kurento-group-call/groupcall',
    BASE_LANDING: './landing.html'
};

const openScreenShare = async (quizId) => {
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

        console.log('Selected source:', selectedSource);

        stream = await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: {
                mandatory: {
                    chromeMediaSource: 'desktop',
                    chromeMediaSourceId: selectedSource.id,
                    minWidth: 1280,
                    maxWidth: 1280,
                    minHeight: 720,
                    maxHeight: 720,
                    maxFrameRate: 15,
                }
            }
        });

        // 🟢 Detect when screen sharing stops
        stream.getVideoTracks()[0].addEventListener('ended', () => {
            console.log('Screen sharing stopped by the user or system');
            body.classList.remove('screen-sharing-active');
            shareScreenBtn.disabled = false;
            stopShareBtn.disabled = true;
            // Optionally, notify backend or clean up resources
            // 🔁 Restart screen sharing
            openScreenShare(quizId);
        });

        // screenView.srcObject = stream;
        // body.classList.add('screen-sharing-active');
        shareScreenBtn.disabled = true;
        stopShareBtn.disabled = false;

        // === Kurento Setup ===
        const ws_token = localStorage.getItem('ws_token');
        const userDetails = JSON.parse(localStorage.getItem('user_details'));
        console.log(userDetails);
        const username = userDetails.email + '_scrn';
        const password = userDetails.id;
        const roomName = quizId; // replace with actual room name
        const screenSharerName = username;

        const streamUrl = `${CONFIG.KURENTO}?token=${ws_token}&user=${username}&pass=${password}`;
        const ws = new WebSocket(streamUrl);

        ws.onopen = () => {
            ws.send(JSON.stringify({
                id: 'joinRoom',
                name: screenSharerName,
                room: 'live-feed-' + roomName
            }));

            publishToKurento(ws, stream, screenSharerName);
        };

    } catch (err) {
        console.error('Error sharing screen:', err);
        //alert('Error sharing screen: ' + err.message);
    }
};
shareScreenBtn.addEventListener('click', () => {
    openScreenShare('9026')
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

stopShareBtn.addEventListener('click', () => {
    if (stream) {
        stream.getTracks().forEach(track => track.stop())
        // screenView.srcObject = null
        body.classList.remove('screen-sharing-active')
        shareScreenBtn.disabled = false
        stopShareBtn.disabled = true
    }
})

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
    const share = await getExamInfo(quizId, tkn); // ✅ await here
    console.log('📺 Share screen required:', share);
    if (share) {
        console.log('👤 Getting student info...');
        getStudentInfo(studentId, tkn, quizId);
    } else {
        console.log('ℹ️ Screen sharing not required for this exam');
    }
});


const getStudentInfo = async (spid, tkn, quizId) => {
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

        openScreenShare(quizId);
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

        if (exam?.shareScreen) return true
        return false;
    } catch (error) {
        console.error('Error calling login API:', error);
        return false;
    }
}