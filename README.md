![Logo](admin/navimow.png)

# ioBroker.navimow

[![NPM version](https://img.shields.io/npm/v/iobroker.navimow.svg)](https://www.npmjs.com/package/iobroker.navimow)
[![Downloads](https://img.shields.io/npm/dm/iobroker.navimow.svg)](https://www.npmjs.com/package/iobroker.navimow)
![Number of Installations](https://iobroker.live/badges/navimow-installed.svg)
![Current version in stable repository](https://iobroker.live/badges/navimow-stable.svg)

[![NPM](https://nodei.co/npm/iobroker.navimow.png?downloads=true)](https://nodei.co/npm/iobroker.navimow/)

**Tests:** ![Test and Release](https://github.com/TA2k/ioBroker.navimow/workflows/Test%20and%20Release/badge.svg)

## navimow adapter for ioBroker

Adapter for NaviMower from Segway

Only login is working.

Status and controlling is secured by custom encryption library by navimow. At the moment there is no way known to simulate the encryption and decryption.

The Navimow has a complex debug detection the app version 1.4.9 is easier to debug then 2.0.0

Example Post request:

```
POST https://navimow-fra.ninebot.com/vehicle/vehicle/index

Payload:
h = MD5 Hash of the payload
k = clientKey
d = postdata =Example AES 128 key: 66 b9 24 37 f7 d5 f4 c4 c1 32 c7 74 fa e9 18 86
AES Key is changing every request
```

Response:

```
  {"keyDataTwo":"5K0E8400-E29","data":"eyJjdXJyZW50X3ZlcnNpb24iO","platform":1,"keyDataOne":"segway.mower","timeStamp":1696799374783,"keyDataThree":"321A2EF1F010","keyDataFour":"52428.278076"}
     data:
     {"current_version":104090001,"checkcode":"1a478b9dcf053990c1900294a834cbff","platform":"iOS","vehicle_type":"20000001","vehicle_sn":"XXXXXX","language":"de","device_id":"XXX-xx-xxx-xxxx-XXXXXXX","serviceTime":1696799373292.8428,"ostype":"ios","platform_ver":"14.8","client_ver":104090001,"access_token":"x.x.w3-x-x","uid":"268XXX"}
```

The app is secured by mutiple frameworks:

```
libRSSupport.so
libbugsnag-root-detection.so
libnbcrypto.so
libnetseckit-4.3.1.so
libbugsnag-ndk.so
libc++_shared.so
libnesec-x86.so
libpl_droidsonroids_gif.so
libbugsnag-plugin-android-anr.so
libmarsxlog.so
libnesec.so
librsjni.so
```

BugSnag

SecNeo:

https://bbs.kanxue.com/thread-273614.htm

https://d0nuts33.github.io/2022/11/24/vmp%E5%8A%A0%E5%9B%BA%E5%88%9D%E6%8E%A2%EF%BC%88%E4%B8%8B%EF%BC%89/index.html

https://zhuanlan.zhihu.com/p/551331698

https://www.leiphone.com/category/gbsecurity/TABfBNU8x0lZIPoT.html

https://blog.csdn.net/weixin_39738152/article/details/111000036

Custom crypto:

libnbcrypto.so

## Changelog

### 0.0.1

- (TA2k) initial release

## License

MIT License

Copyright (c) 2023 TA2k <tombox2020@gmail.com>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
