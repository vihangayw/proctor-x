const shareScreenBtn = document.getElementById('shareScreen')
const stopShareBtn = document.getElementById('stopShare')
const screenView = document.getElementById('screenView');
const exitAppBtn = document.getElementById('exitApp')
const lmsFrame = document.getElementById('lmsFrame')
const body = document.body

let stream = null
// Your renderer code
const quizId = '56565f34-9e79-4f6e-972e-0aefbfcc111e';
const userId = '123456';
const uuid = crypto.randomUUID();

shareScreenBtn.addEventListener('click', async () => {
  try {
    // {
    //   const sources = await window.electronAPI.getSources()
    //   const selectedSource = sources[0]
    //   console.log(selectedSource)
    // }
    //

    const sources = await window.electronAPI.getSources( );
    console.log(sources)
    const platform = await window.electronAPI.getPlatform();
    // Select the entire screen (primary display)
    let selectedSource = sources.find(source => {
      // macOS
      if (platform === 'darwin') {
        return source.name.includes('Entire screen') || source.display_id === '1';
      }
      // Windows
      else if (platform === 'win32') {
        return source.name.includes('Screen') || source.display_id.includes('DISPLAY');
      }
      // Linux
      else {
        return source.name.includes('Screen');
      }
    });

    if (!selectedSource) {
      selectedSource = sources[0]
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
          maxHeight: 720
        }
      }
    })
    console.log('Got stream:', stream);

    body.classList.add('screen-sharing-active')
    screenView.style.width = '100%';
    screenView.style.height = 'auto';
    screenView.srcObject = stream
     shareScreenBtn.disabled = true
    stopShareBtn.disabled = false
  } catch (err) {
    console.error('Error sharing screen:', err)
    alert('Error sharing screen: ' + err.message)
  }
})

stopShareBtn.addEventListener('click', () => {
  if (stream) {
    stream.getTracks().forEach(track => track.stop())
    screenView.srcObject = null
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
window.electronAPI.onQuizData((data) => {
  const { quizId, userId } = data;
  const uuid = crypto.randomUUID();
  const iframe = document.getElementById('lmsFrame');
  const quizUrl = `http://localhost:3000/e-quiz/${quizId}/${uuid}`;
  console.info(quizUrl)
  iframe.src = quizUrl;
});

document.addEventListener('DOMContentLoaded', () => {
  const quizId = '56565f34-9e79-4f6e-972e-0aefbfcc111e'; // Example
  const userId = 'some-user-id-or-value'; // You can pull this from storage, input, or arguments

  const uuid = crypto.randomUUID(); // Generate a random UUID

  const iframe = document.getElementById('lmsFrame');
  console.info("DOMContentLoaded")

  const quizUrl = `https://localhost:8443/kurento-group-call/`; // Customize this
  console.info(quizUrl)
  iframe.src = quizUrl;
});

window.electronAPI.onLaunchData((data) => {
  console.info("onLaunchData")
  const { quizId, studentId, tkn, sqid } = data;//spid
  console.log('🚀 Got launch data:', data);

  const iframe = document.getElementById('lmsFrame');
   iframe.src = `http://localhost:3001/mcq-preview/${quizId}/${tkn}/${studentId}/${sqid}`;
});