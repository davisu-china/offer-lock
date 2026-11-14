/**
 * Copyright FunASR (https://github.com/alibaba-damo-academy/FunASR). All Rights
 * Reserved. MIT License  (https://opensource.org/licenses/MIT)
 */
/* 2022-2023 by zhaoming,mali aihealthx.com */

// 连接; 定义socket连接类对象与语音对象
var wsconnecter = new WebSocketConnectMethod({
  msgHandle: getJsonMessage,
  stateHandle: getConnState,
});
var audioBlob;

// 录音; 定义录音对象,wav格式
var rec = Recorder({
  type: "pcm",
  bitRate: 16,
  sampleRate: 16000,
  onProcess: recProcess,
});

// ===== Mixed capture state =====
var audioCtx;
var micStream;
var sysStream;

async function getMixedStream() {
  // 智能设备选择：自动识别麦克风和立体声混音
  var devices = await navigator.mediaDevices.enumerateDevices();
  var audioInputs = devices.filter((d) => d.kind === "audioinput");

  console.log(
    "检测到音频设备:",
    audioInputs.map((d) => d.label),
  );

  // 1) 自动找麦克风（排除立体声混音）
  var micDevice =
    audioInputs.find((d) => {
      var label = d.label.toLowerCase();
      return (
        !label.includes("stereo") &&
        !label.includes("立体声") &&
        !label.includes("mix") &&
        !label.includes("混音") &&
        (label.includes("mic") ||
          label.includes("麦克风") ||
          d.deviceId === "default")
      );
    }) || audioInputs[0];

  // 2) 自动找立体声混音
  var stereoDevice = audioInputs.find((d) => {
    var label = d.label.toLowerCase();
    return (
      label.includes("stereo") ||
      label.includes("立体声") ||
      label.includes("mix") ||
      label.includes("混音")
    );
  });

  console.log("选择麦克风:", micDevice.label);
  if (stereoDevice) console.log("选择立体声混音:", stereoDevice.label);

  // 3) 分别获取音频流
  micStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: { exact: micDevice.deviceId },
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: false,
    },
  });

  if (stereoDevice) {
    try {
      sysStream = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: { exact: stereoDevice.deviceId } },
      });
      console.log("✓ 成功获取面试官音频(立体声混音)");
    } catch (e) {
      console.warn("立体声混音获取失败:", e);
      sysStream = null;
    }
  } else {
    console.warn("未找到立体声混音，仅使用麦克风");
    sysStream = null;
  }

  // 4) AudioContext 混音
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  var dest = audioCtx.createMediaStreamDestination();

  // 麦克风路径
  var micNode = audioCtx.createMediaStreamSource(micStream);
  var micGain = audioCtx.createGain();
  micGain.gain.value = 1.0; // 你的声音正常音量
  micNode.connect(micGain).connect(dest);

  // 系统音频路径
  if (sysStream) {
    var sysNode = audioCtx.createMediaStreamSource(sysStream);
    var sysGain = audioCtx.createGain();
    sysGain.gain.value = 0.8; // 面试官声音稍微小点，避免压过你的声音
    sysNode.connect(sysGain).connect(dest);

    console.log("✓ 混合流已创建：麦克风 + 立体声混音");
  } else {
    console.log("✓ 单路流已创建：仅麦克风");
  }

  return dest.stream;
}

var sampleBuf = new Int16Array();
// 定义按钮响应事件
var btnStart = document.getElementById("btnStart");
btnStart.onclick = record;
var btnStop = document.getElementById("btnStop");
btnStop.onclick = stop;
btnStop.disabled = true;
btnStart.disabled = true;

btnConnect = document.getElementById("btnConnect");
btnConnect.onclick = start;

var awsslink = document.getElementById("wsslink");

var rec_text = ""; // for online rec asr result
var offline_text = ""; // for offline rec asr result
var info_div = document.getElementById("info_div");

var upfile = document.getElementById("upfile");

var isfilemode = false; // if it is in file mode
var file_ext = "";
var file_sample_rate = 16000; //for wav file sample rate
var file_data_array; // array to save file data

var totalsend = 0;

// 添加一个全局变量，用于跟踪上次发送的文本长度
var lastSentTextLength = 0;

// 自动设置WebSocket地址为Docker服务地址
// document.getElementById('wssip').value = "ws://localhost:10096/";
document.getElementById("wssip").value = "ws://47.117.46.252:10096/";

addresschange();

function addresschange() {
  var Uri = document.getElementById("wssip").value;
  document.getElementById("info_wslink").innerHTML =
    "点此处手工授权（IOS手机）";
  Uri = Uri.replace(/wss/g, "https");
  console.log("addresschange uri=", Uri);

  awsslink.onclick = function () {
    window.open(Uri, "_blank");
  };
}

upfile.onclick = function () {
  btnStart.disabled = true;
  btnStop.disabled = true;
  btnConnect.disabled = false;
};

// from https://github.com/xiangyuecn/Recorder/tree/master
var readWavInfo = function (bytes) {
  //读取wav文件头，统一成44字节的头
  if (bytes.byteLength < 44) {
    return null;
  }
  var wavView = bytes;
  var eq = function (p, s) {
    for (var i = 0; i < s.length; i++) {
      if (wavView[p + i] != s.charCodeAt(i)) {
        return false;
      }
    }
    return true;
  };

  if (eq(0, "RIFF") && eq(8, "WAVEfmt ")) {
    var numCh = wavView[22];
    if (wavView[20] == 1 && (numCh == 1 || numCh == 2)) {
      //raw pcm 单或双声道
      var sampleRate =
        wavView[24] +
        (wavView[25] << 8) +
        (wavView[26] << 16) +
        (wavView[27] << 24);
      var bitRate = wavView[34] + (wavView[35] << 8);
      var heads = [wavView.subarray(0, 12)],
        headSize = 12; //head只保留必要的块
      //搜索data块的位置
      var dataPos = 0; // 44 或有更多块
      for (var i = 12, iL = wavView.length - 8; i < iL; ) {
        if (
          wavView[i] == 100 &&
          wavView[i + 1] == 97 &&
          wavView[i + 2] == 116 &&
          wavView[i + 3] == 97
        ) {
          //eq(i,"data")
          heads.push(wavView.subarray(i, i + 8));
          headSize += 8;
          dataPos = i + 8;
          break;
        }
        var i0 = i;
        i += 4;
        i +=
          4 +
          wavView[i] +
          (wavView[i + 1] << 8) +
          (wavView[i + 2] << 16) +
          (wavView[i + 3] << 24);
        if (i0 == 12) {
          //fmt
          heads.push(wavView.subarray(i0, i));
          headSize += i - i0;
        }
      }
      if (dataPos) {
        var wavHead = new Uint8Array(headSize);
        for (var i = 0, n = 0; i < heads.length; i++) {
          wavHead.set(heads[i], n);
          n += heads[i].length;
        }
        return {
          sampleRate: sampleRate,
          bitRate: bitRate,
          numChannels: numCh,
          wavHead44: wavHead,
          dataPos: dataPos,
        };
      }
    }
  }
  return null;
};

upfile.onchange = function () {
  var len = this.files.length;
  for (let i = 0; i < len; i++) {
    let fileAudio = new FileReader();
    fileAudio.readAsArrayBuffer(this.files[i]);

    file_ext = this.files[i].name.split(".").pop().toLowerCase();
    var audioblob;
    fileAudio.onload = function () {
      audioblob = fileAudio.result;

      file_data_array = audioblob;

      info_div.innerHTML = "请点击连接进行识别";
    };

    fileAudio.onerror = function (e) {
      console.log("error" + e);
    };
  }
  // for wav file, we  get the sample rate
  if (file_ext == "wav")
    for (let i = 0; i < len; i++) {
      let fileAudio = new FileReader();
      fileAudio.readAsArrayBuffer(this.files[i]);
      fileAudio.onload = function () {
        audioblob = new Uint8Array(fileAudio.result);

        // for wav file, we can get the sample rate
        var info = readWavInfo(audioblob);
        console.log(info);
        file_sample_rate = info.sampleRate;
      };
    }
};

function play_file() {
  var audioblob = new Blob([new Uint8Array(file_data_array)], {
    type: "audio/wav",
  });
  var audio_record = document.getElementById("audio_record");
  audio_record.src = (window.URL || webkitURL).createObjectURL(audioblob);
  audio_record.controls = true;
  //audio_record.play();  //not auto play
}
function start_file_send() {
  sampleBuf = new Uint8Array(file_data_array);

  var chunk_size = 960; // for asr chunk_size [5, 10, 5]

  while (sampleBuf.length >= chunk_size) {
    sendBuf = sampleBuf.slice(0, chunk_size);
    totalsend = totalsend + sampleBuf.length;
    sampleBuf = sampleBuf.slice(chunk_size, sampleBuf.length);
    wsconnecter.wsSend(sendBuf);
  }

  stop();
}

function on_recoder_mode_change() {
  var item = null;
  var obj = document.getElementsByName("recoder_mode");
  for (var i = 0; i < obj.length; i++) {
    //遍历Radio
    if (obj[i].checked) {
      item = obj[i].value;
      break;
    }
  }
  if (item == "mic") {
    document.getElementById("mic_mode_div").style.display = "block";
    document.getElementById("rec_mode_div").style.display = "none";

    btnStart.disabled = true;
    btnStop.disabled = true;
    btnConnect.disabled = false;
    isfilemode = false;
  } else {
    document.getElementById("mic_mode_div").style.display = "none";
    document.getElementById("rec_mode_div").style.display = "block";

    btnStart.disabled = true;
    btnStop.disabled = true;
    btnConnect.disabled = true;
    isfilemode = true;
    info_div.innerHTML = "请点击选择文件";
  }
}

function getHotwords() {
  var obj = document.getElementById("varHot");

  if (typeof obj == "undefined" || obj == null || obj.value.length <= 0) {
    return null;
  }
  let val = obj.value.toString();

  console.log("hotwords=" + val);
  let items = val.split(/[(\r\n)\r\n]+/); //split by \r\n
  var jsonresult = {};
  const regexNum = /^[0-9]*$/; // test number
  for (item of items) {
    let result = item.split(" ");
    if (result.length >= 2 && regexNum.test(result[result.length - 1])) {
      var wordstr = "";
      for (var i = 0; i < result.length - 1; i++)
        wordstr = wordstr + result[i] + " ";

      jsonresult[wordstr.trim()] = parseInt(result[result.length - 1]);
    }
  }
  console.log("jsonresult=" + JSON.stringify(jsonresult));
  return JSON.stringify(jsonresult);
}
function getAsrMode() {
  var item = null;
  var obj = document.getElementsByName("asr_mode");
  for (var i = 0; i < obj.length; i++) {
    //遍历Radio
    if (obj[i].checked) {
      item = obj[i].value;
      break;
    }
  }
  if (isfilemode) {
    item = "offline";
  }
  console.log("asr mode" + item);

  return item;
}

function handleWithTimestamp(tmptext, tmptime) {
  console.log("tmptext: " + tmptext);
  console.log("tmptime: " + tmptime);
  if (tmptime == null || tmptime == "undefined" || tmptext.length <= 0) {
    return tmptext;
  }
  tmptext = tmptext.replace(/。|？|，|、|\?|\.|\ /g, ","); // in case there are a lot of "。"
  var words = tmptext.split(","); // split to chinese sentence or english words
  var jsontime = JSON.parse(tmptime); //JSON.parse(tmptime.replace(/\]\]\[\[/g, "],[")); // in case there are a lot segments by VAD
  var char_index = 0; // index for timestamp
  var text_withtime = "";
  for (var i = 0; i < words.length; i++) {
    if (words[i] == "undefined" || words[i].length <= 0) {
      continue;
    }
    console.log("words===", words[i]);
    console.log(
      "words: " + words[i] + ",time=" + jsontime[char_index][0] / 1000,
    );
    if (/^[a-zA-Z]+$/.test(words[i])) {
      // if it is english
      text_withtime =
        text_withtime + jsontime[char_index][0] / 1000 + ":" + words[i] + "\n";
      char_index = char_index + 1; //for english, timestamp unit is about a word
    } else {
      // if it is chinese
      text_withtime =
        text_withtime + jsontime[char_index][0] / 1000 + ":" + words[i] + "\n";
      char_index = char_index + words[i].length; //for chinese, timestamp unit is about a char
    }
  }
  return text_withtime;
}
// 语音识别结果; 对jsonMsg数据解析,将识别结果附加到编辑框中
function getJsonMessage(jsonMsg) {
  //console.log(jsonMsg);
  console.log("message: " + JSON.parse(jsonMsg.data)["text"]);
  var rectxt = "" + JSON.parse(jsonMsg.data)["text"];
  var asrmodel = JSON.parse(jsonMsg.data)["mode"];
  var is_final = JSON.parse(jsonMsg.data)["is_final"];
  var timestamp = JSON.parse(jsonMsg.data)["timestamp"];

  // 为显示目的处理文本（包含时间戳）
  if (asrmodel == "2pass-offline" || asrmodel == "offline") {
    offline_text = offline_text + handleWithTimestamp(rectxt, timestamp);
    rec_text = offline_text;
  } else {
    rec_text = rec_text + rectxt;
  }

  var varArea = document.getElementById("varArea");
  varArea.value = rec_text;

  console.log("offline_text: " + asrmodel + "," + offline_text);
  console.log("rec_text: " + rec_text);

  // 在2pass-offline模式或is_final为true时发送结果
  // 直接发送原始文本，不包含时间戳
  if (
    (asrmodel == "2pass-offline" ||
      asrmodel == "offline" ||
      is_final === true) &&
    window.electronAPI &&
    window.electronAPI.send &&
    rectxt &&
    rectxt.trim() !== ""
  ) {
    // 修正文本：如果文本以标点符号开头，则移除它
    var cleanText = rectxt;
    if (/^[，。？！、,.?!;；]/.test(cleanText)) {
      cleanText = cleanText.substring(1);
    }

    console.log("原始识别文本(JSON):", JSON.stringify(rectxt));
    console.log("修正后的文本:", cleanText);

    // 检查文本中的标点符号
    var punctuation = cleanText.match(/[。？！，、.?!,;；]/g);
    if (punctuation) {
      console.log("文本中包含的标点符号:", punctuation.join(""));
    } else {
      console.log("文本中不包含标点符号");
    }

    // 发送修正后的文本到主窗口
    window.electronAPI.send("voice-transcript", cleanText);
  } else if (window.electronAPI && window.electronAPI.send) {
    console.log("中间识别结果，暂不发送:", rectxt);
  } else {
    console.log("electronAPI不存在或send方法不可用，无法发送识别结果");
  }

  if (isfilemode == true && is_final == true) {
    console.log("call stop ws!");
    play_file();
    wsconnecter.wsStop();

    info_div.innerHTML = "请点击连接";

    btnStart.disabled = true;
    btnStop.disabled = true;
    btnConnect.disabled = false;
  }
}

// 连接状态响应
function getConnState(connState) {
  if (connState === 0) {
    //on open

    info_div.innerHTML = "连接成功!请点击开始";
    if (isfilemode == true) {
      info_div.innerHTML = "请耐心等待,大文件等待时间更长";
      start_file_send();
    } else {
      btnStart.disabled = false;
      btnStop.disabled = true;
      btnConnect.disabled = true;
    }
  } else if (connState === 1) {
    //stop();
  } else if (connState === 2) {
    stop();
    console.log("connecttion error");

    // alert("连接地址"+document.getElementById('wssip').value+"失败,请检查asr地址和端口。或试试界面上手动授权，再连接。");
    alert("连接失败,请联系管理员");
    btnStart.disabled = true;
    btnStop.disabled = true;
    btnConnect.disabled = false;

    info_div.innerHTML = "请点击连接";
  }
}

function record() {
  (async function () {
    try {
      var mixed = await getMixedStream();
      rec.set.sourceStream = mixed;
      rec.open(function () {
        rec.start();
        console.log("开始(混合流)");
        btnStart.disabled = true;
        btnStop.disabled = false;
        btnConnect.disabled = true;
      });
    } catch (e) {
      console.error("record start failed:", e);
      info_div.innerHTML = "音频权限或系统音频不可用";
    }
  })();
}

// 识别启动、停止、清空操作
function start() {
  // 清除显示
  clear();
  //控件状态更新
  console.log("isfilemode" + isfilemode);

  //启动连接
  var ret = wsconnecter.wsStart();
  // 1 is ok, 0 is error
  if (ret == 1) {
    info_div.innerHTML = "正在连接asr服务器，请等待...";
    isRec = true;
    btnStart.disabled = true;
    btnStop.disabled = true;
    btnConnect.disabled = true;

    return 1;
  } else {
    info_div.innerHTML = "请点击开始";
    btnStart.disabled = true;
    btnStop.disabled = true;
    btnConnect.disabled = false;

    return 0;
  }
}

function stop() {
  var chunk_size = new Array(5, 10, 5);
  var request = {
    chunk_size: chunk_size,
    wav_name: "h5",
    is_speaking: false,
    chunk_interval: 10,
    mode: getAsrMode(),
  };
  console.log(request);
  if (sampleBuf.length > 0) {
    wsconnecter.wsSend(sampleBuf);
    console.log("sampleBuf.length" + sampleBuf.length);
    sampleBuf = new Int16Array();
  }
  wsconnecter.wsSend(JSON.stringify(request));

  // 控件状态更新

  isRec = false;
  info_div.innerHTML = "发送完数据,请等候,正在识别...";

  if (isfilemode == false) {
    btnStop.disabled = true;
    btnStart.disabled = true;
    btnConnect.disabled = true;
    //wait 3s for asr result
    setTimeout(function () {
      console.log("call stop ws!");
      wsconnecter.wsStop();
      btnConnect.disabled = false;
      info_div.innerHTML = "请点击连接";
    }, 3000);

    rec.stop(
      function (blob, duration) {
        console.log(blob);
        var audioBlob = Recorder.pcm2wav(
          (data = { sampleRate: 16000, bitRate: 16, blob: blob }),
          function (theblob, duration) {
            console.log(theblob);
            var audio_record = document.getElementById("audio_record");
            audio_record.src = (window.URL || webkitURL).createObjectURL(
              theblob,
            );
            audio_record.controls = true;
            //audio_record.play();
          },
          function (msg) {
            console.log(msg);
          },
        );

        // 追加：释放音频资源
        try {
          if (micStream)
            micStream.getTracks().forEach(function (t) {
              t.stop();
            });
          if (sysStream)
            sysStream.getTracks().forEach(function (t) {
              t.stop();
            });
          if (audioCtx && audioCtx.state !== "closed") audioCtx.close();
        } catch (e) {
          console.warn("cleanup failed:", e);
        }
      },
      function (errMsg) {
        console.log("errMsg: " + errMsg);
      },
    );
  }
  // 停止连接
}

function clear() {
  var varArea = document.getElementById("varArea");

  varArea.value = "";
  rec_text = "";
  offline_text = "";

  // 重置已发送的文本长度
  lastSentTextLength = 0;
}

function recProcess(
  buffer,
  powerLevel,
  bufferDuration,
  bufferSampleRate,
  newBufferIdx,
  asyncEnd,
) {
  if (isRec === true) {
    var data_48k = buffer[buffer.length - 1];

    var array_48k = new Array(data_48k);
    var data_16k = Recorder.SampleData(array_48k, bufferSampleRate, 16000).data;

    sampleBuf = Int16Array.from([...sampleBuf, ...data_16k]);
    var chunk_size = 960; // for asr chunk_size [5, 10, 5]
    info_div.innerHTML = "" + bufferDuration / 1000 + "s";
    while (sampleBuf.length >= chunk_size) {
      sendBuf = sampleBuf.slice(0, chunk_size);
      sampleBuf = sampleBuf.slice(chunk_size, sampleBuf.length);
      wsconnecter.wsSend(sendBuf);
    }
  }
}

function getUseITN() {
  var obj = document.getElementsByName("use_itn");
  for (var i = 0; i < obj.length; i++) {
    if (obj[i].checked) {
      return obj[i].value === "true";
    }
  }
  return false;
}
