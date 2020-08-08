import axios from 'axios'

import Vue from 'vue'
import Emittery from 'emittery'

// const errors = {
//   email_verification: 'Your email has not been verified. Please verify your email before attempting to log in.',
//   bad_request: 'The login request was malformed. Please contact the website admins.',
//   bad_credentails: 'Invalid username or password'
// }

class FusionAuth {
  constructor (applicationId, domain, LoginComponent, opts = {}, mount = document.body) {
    const self = this

    const { loginUri, storage = window.localStorage, keys = {} } = opts
    const { prefix = 'generic-login', tokens = 'tokens', profile = 'profile', lastLogin = 'last-login' } = keys

    // Create the div under which the lock is going to live
    const el = document.createElement('div')
    el.id = '__fusionauth-login__'
    el.innerHTML = '<div id="__fusionauth__"></div>'
    mount.appendChild(el)
    // Regardless of what the constructor tells us, we set show to false

    const control = {
      show: false,
      error: '',
      info: '',
      isSubmitting: false,
      loggedInId: undefined,
      initialized: false
    }

    const vue = new Vue({
      data: {
        // We need these here so that they become Vue.observable before we spread them in render
        control,
        opts
      },
      methods: {
        onShowChange (isShowing) {
          this.control.show = isShowing
          this.$emit('modal-event', isShowing)
        },
        async commonSubmit (data, executor) {
          this.control.error = ''
          this.control.info = ''
          this.control.isSubmitting = true
          try {
            await new Promise(resolve => {
              setTimeout(resolve, 300)
            })
            await executor(data)
          } catch (e) {
            this.control.error = e.message
          } finally {
            this.control.isSubmitting = false
          }
        },
        async onSocialLogin (data) {
          if (data.error) {
            this.control.error = data.error
            return
          }
          await self.socialLogin(data)
          this.control.show = false
        }
      },
      render (h) {
        return h(LoginComponent, {
          props: {
            ...this.opts,
            ...(this.opts.links || {}),
            ...this.control
          },
          ref: 'login',
          on: {
            'update:show': this.onShowChange,
            'update:info': val => { this.control.info = val },
            'update:error': val => { this.control.error = val },
            login: data => this.commonSubmit(data, self.login.bind(self)),
            signup: data => this.commonSubmit(data, self.register.bind(self)),
            'forgot-password': data => this.commonSubmit(data, self.forgotPassword.bind(self)),
            'social-login': this.onSocialLogin,
            'last-login-login': self.lastLoginLogin.bind(self),
            'modal:closed': () => this.$emit('modal:closed'),
            'modal:opened': () => this.$emit('modal:opened')
          }
        })
      }
    })

    Object.assign(this, {
      applicationId,
      tokensKey: `${prefix}:${tokens}`,
      profileKey: `${prefix}:${profile}`,
      lastLoginCredentialsKey: `${prefix}:${lastLogin}`,
      storage,
      loginUri,
      opts,
      el,
      control,
      vue
    })
    new Emittery().bindMethods(this)

    vue.$mount(mount.querySelector('#__fusionauth__'))
    vue.$on('modal-event', isShowing => { this.emit('modal-event', isShowing) })
  }

  async open () {
    const { lastLoginCredentialsKey, loginUri, storage, control } = this

    control.error = ''
    control.info = ''
    control.initialized = false
    control.show = true

    // Check lastLoginCredentials
    if (!this.control.loggedInId) {
      try {
        const lastLoginCredentialsStr = storage.getItem(lastLoginCredentialsKey)
        const lastLoginCredentials = JSON.parse(lastLoginCredentialsStr)
        const { type, provider, data } = lastLoginCredentials
        const response = await axios.get(`${loginUri}/last-login-info`, {
          params: {
            lastLoginCredentials: data
          }
        })
        const { data: { username } } = response
        this.control.loggedInId = {
          email: username,
          type,
          provider
        }
      } catch (e) {
      }
    }
    control.initialized = true
  }

  async close () {
    const promise = new Promise(resolve => {
      this.vue.$once('modal:closed', resolve)
    })
    this.control.show = false
    return promise
  }

  async login ({ username, password, lastLoginCredentials }) {
    const { applicationId, loginUri, storage } = this
    try {
      const response = await axios.post(`${loginUri}/login`, {
        applicationId,
        username,
        password,
        lastLoginCredentials,
        scope: this.opts.auth.scope
      })
      const { data } = response
      const { lastLoginCredentials: newLastLoginCredentials } = data
      storage.setItem(this.lastLoginCredentialsKey, JSON.stringify(newLastLoginCredentials))
      await this.close()
      this.emit('authenticated', data)
    } catch (e) {
      if (e.response) {
        throw new Error(e.response.data)
      } else {
        throw e
      }
    }
  }

  async socialLogin ({ provider, access_token: accessToken, id_token: idToken, lastLoginCredentials }) {
    const { applicationId, loginUri, lastLoginCredentialsKey, storage } = this
    const providerClientId = this.opts.social.providers[provider].clientId
    const finalToken = idToken || accessToken
    try {
      let device
      if (this.opts.auth.scope.includes('offline_access')) {
        // We need to get a refresh token
        // To do so, we need to add the 'device' parameter
        device = this.opts.auth.device
      }
      const response = await axios.post(`${loginUri}/social-login`, {
        applicationId,
        provider,
        token: finalToken,
        clientId: providerClientId,
        device,
        lastLoginCredentials
      })
      const { data } = response
      const { lastLoginCredentials: newLastLoginCredentials } = data
      storage.setItem(lastLoginCredentialsKey, JSON.stringify(newLastLoginCredentials))
      await this.close()
      this.emit('authenticated', data)
    } catch (e) {
      throw new Error(e.response.data)
    }
  }

  async lastLoginLogin () {
    const { storage, lastLoginCredentialsKey } = this
    const lastLoginCredentialsStr = storage.getItem(lastLoginCredentialsKey)
    const lastLoginCredentials = JSON.parse(lastLoginCredentialsStr)
    const { type, provider, data } = lastLoginCredentials
    switch (type) {
      case 'email':
        return this.login({ lastLoginCredentials: data })
      case 'social':
        return this.socialLogin({ provider, lastLoginCredentials: data })
    }
  }

  async register ({ username, password }) {
    const { loginUri } = this
    try {
      const response = await axios.post(`${loginUri}/register`, {
        email: username,
        password
      })
      this.control.info = response.data
      this.vue.$refs.login.currentTab = 'LOGIN'
    } catch (e) {
      this.control.error = e.response.data
    }
  }

  async forgotPassword ({ username }) {
    const { applicationId, loginUri } = this
    try {
      const response = await axios.post(`${loginUri}/forgot-password`, {
        applicationId,
        email: username
      })
      this.control.info = response.data
      this.vue.$refs.login.currentTab = 'LOGIN'
    } catch (e) {
      this.control.error = e.response.data
    }
  }

  async logout () {
    const { storage, lastLoginCredentialsKey } = this
    storage.removeItem(lastLoginCredentialsKey)
    this.control.loggedInId = undefined
  }
}

export default FusionAuth
