const shelljs = require('shelljs')
const path = require('path')
const fs = require('fs')
const md5 = require('crypto-js/md5')
const fkill = require('fkill')
const io = require('socket.io')({
  cors: {
    origin: "*"
  }
})

/**
 * 配置方式：
 * 1. 部署nginx，将本目录拷贝到nginx托管的根目录下
 * 2. 安装nodejs v12.18.3
 * 3. 配置下面的nginxPath
 * 4. 配置socket端口
 * 5. 进入本目录，运行 npm i
 * 6. 执行 npm start
 */
const config = {
  nginxPath: 'http://192.168.1.23:8500/', // nginx服务地址
  wsPort: 3000 // socket端口
}

const storage = {} // 存储每个rtsp与用户的对应关系
const taskQueue = [] // 排队转码

/**
 * 生成转码后的m3u8地址
 * @param {String} rtspURL rtsp地址
 * @return {String}
 */
function getFileName(rtspURL) {
  return './bear/' + md5(rtspURL) + '.m3u8'
}

/**
 * 调起ffmpeg执行转码任务
 * @param {Object} task 任务对象，携带了userId与rtspURL
 */
function startTranscodeTask(task) {
  const { userId, rtspURL } = task
  const file = getFileName(rtspURL)
  const hls = config.nginxPath + path.join(__dirname.split(path.sep).pop(), file).replace(/\\/g, '/') // nginx服务地址

  if (storage[file]) {
    console.log('已开启子进程转码，无需重复转码')
    storage[file].users.push(userId)
    return io.to(userId).emit('play', hls)
  } 

  const childProcess = shelljs.exec(`ffmpeg -rtsp_transport tcp -i "${rtspURL}" -c copy -c:v libx264 -c:a aac -f hls -hls_time 2.0 -hls_list_size 5 -hls_wrap 20 ${path.join(__dirname, file)}`, {
    async: true,
    silent: true
  }, (code, stdout, stderr) => {
    console.log('exit', code)
    if (storage[file] && storage[file].killing === false) { // 说明不是主动发起的杀进程, 因此出现异常时，重新加入队列去转码
      console.log('出现转码异常，重新加入队列')
      clearInterval(storage[file].timer)
      storage[file] = null
      taskQueue.push(task)
    }
    fs.writeFileSync('./errorLog/' + userId + '-' + new Date().getTime() + '-stderr.txt', String(stderr))
  })
  console.log('ffmpeg子进程id:', childProcess.pid)
  storage[file] = {
    pid: childProcess.pid, // 子进程ID
    killing: false, // 是否正在杀死该进程
    timer: 0, // 定时器
    users: [userId] // 用户集合
  }

  clearInterval(storage[file].timer)
  storage[file].timer = setInterval(() => {
    const isExist = fs.existsSync(file)
    if (isExist) {
      clearInterval(storage[file].timer)
      console.log('转码成功, 地址:' + hls)
      io.to(userId).emit('play', hls)
    }
  }, 1000)
}

/**
 * 检查缓存中已经失去所有用户连接的ffmpeg进程并关闭
 * @param {String} userId socket id
 */
function checkStorage(userId) {
  for (let file in storage) {
    if (!storage[file]) {
      continue
    }
    const { users } = storage[file]
    const index = users.findIndex(_ => _ === userId)
    if (index > -1) {
      users.splice(index, 1)
      console.log('用户列表', users)
      if (users.length === 0) {
        console.log('用户列表已清空，尝试关闭子进程' + storage[file].pid)
        storage[file].killing = true
        fkill(storage[file].pid, { force: true, tree: true }).then(() => {
          console.log('子进程已关闭')
          if (fs.existsSync(file)) {
            fs.unlinkSync(file)
          }
          storage[file] = null
        }).catch(e => {
          storage[file].killing = false
          console.error(e)
        })
      }
      break
    }
  }
}

/**
 * 定时执行转码任务
 */
function loopTasks() {
  setInterval(() => {
    if (taskQueue.length === 0) return
    const task = taskQueue.shift()
    const file = getFileName(task.rtspURL)
    if (storage[file] && storage[file].killing) {
      taskQueue.push(task)
    } else {
      console.log('开始新转码任务')
      startTranscodeTask(task)
    }
  }, 2000) // 每2秒执行开始一次新的转码
}

/**
 * 启动socket服务
 */
function launchServer() {
  io.on('connection', socket => {
    console.log(`用户${socket.id}已加入`)
    socket.on('transcode', ({ rtspURL }) => {
      console.log('加入转码队列')
      taskQueue.push({ userId: socket.id, rtspURL })
    })
    
    socket.on('disconnect', () => {
      console.log(`用户${socket.id}已退出`)
      checkStorage(socket.id)
    })
  })
  io.listen(config.wsPort)
  console.log('socket服务已启动, 监听的端口为' + config.wsPort)
  loopTasks()
  console.log('开始定时执行转码任务')
}

launchServer()
