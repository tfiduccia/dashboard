import Steve from '@/plugins/steve';
import {
  API_GROUP, COUNT, NAMESPACE, NORMAN, RANCHER
} from '@/config/types';
import { CLUSTER as CLUSTER_PREF, NAMESPACES } from '@/store/prefs';
import SYSTEM_NAMESPACES from '@/config/system-namespaces';
import { allHash } from '@/utils/promise';
import { ClusterNotFoundError } from '@/utils/error';

// disables stict mode for all store instances to prevent mutation errors
export const strict = false;

export const plugins = [
  Steve({ namespace: 'management', baseUrl: '/v1' }),
  Steve({ namespace: 'cluster', baseUrl: '' }),
  Steve({ namespace: 'rancher', baseUrl: '/v3' }),
  Steve({ namespace: 'clusterExternal', baseUrl: '' }), // project scoped cluster stuff
];

export const state = () => {
  return {
    managementReady:  false,
    clusterReady:    false,
    namespaces:      [],
    allNamespaces:   null,
    clusterId:       null,
  };
};

export const getters = {
  multipleNamespaces(state, getters) {
    return state.namespaces.length !== 1;
  },

  clusterId(state) {
    return state.clusterId;
  },

  currentCluster(state, getters) {
    return getters['management/byId'](RANCHER.CLUSTER, state.clusterId);
  },

  namespaces(state) {
    const namespaces = state.namespaces;

    if ( namespaces.length ) {
      return namespaces;
    } else {
      return SYSTEM_NAMESPACES.map(x => `!${ x }`);
    }
  },
};

export const mutations = {
  managementChanged(state, ready) {
    state.managementReady = ready;
  },

  clusterChanged(state, ready) {
    state.clusterReady = ready;
  },

  updateNamespaces(state, { selected, all }) {
    state.namespaces = selected;

    if ( all ) {
      state.allNamespaces = all;
    }
  },

  setCluster(state, neu) {
    state.clusterId = neu;
  },
};

export const actions = {
  async loadManagement({ state, commit, dispatch }) {
    if ( state.managementReady ) {
      // Do nothing, it's already loaded
      return;
    }

    console.log('Loading management...');

    try {
      await dispatch('rancher/findAll', { type: NORMAN.PRINCIPAL, opt: { url: 'principals' } });
    } catch (e) {
      // Maybe not Rancher
    }

    await allHash({
      prefs:      dispatch('prefs/loadCookies'),
      management: Promise.all([
        dispatch('management/subscribe'),
        dispatch('management/loadSchemas'),
        dispatch('management/findAll', { type: RANCHER.CLUSTER, opt: { url: 'management.cattle.io.v3.clusters' } }),
      ]),
    });

    commit('managementChanged', true);

    console.log('Done loading management.');
  },

  async loadCluster({
    state, commit, dispatch, getters
  }, id) {
    if ( state.clusterReady && state.clusterId && state.clusterId === id ) {
      // Do nothing, we're already connected to this cluster
      return;
    }

    if ( state.clusterId && id ) {
      // Clear the old cluster state out if switching to a new one.
      // If there is not an id then stay connected to the old one behind the scenes,
      // so that the nav and header stay the same when going to things like prefs
      await dispatch('cluster/unsubscribe');
      await dispatch('clusterExternal/unsubscribe');
      commit('cluster/removeAll');
      commit('clusterExternal/removeAll');
      commit('clusterChanged', false);
    }

    if ( id ) {
      // Remember the new one
      commit('prefs/set', { key: CLUSTER_PREF, id });
      commit('setCluster', id);
    } else {
      return;
    }

    console.log('Loading cluster...');

    // See if it really exists
    const cluster = dispatch('management/find', {
      type: RANCHER.CLUSTER,
      id,
      opt:  { url: `management.cattle.io.v3.clusters/${ escape(id) }` }
    });

    if ( !cluster ) {
      commit('setCluster', null);
      commit('cluster/applyConfig', { baseUrl: null });
      commit('clusterExternal/applyConfig', { baseUrl: null });
      throw new ClusterNotFoundError(id);
    }

    // Update the Steve client URL
    commit('cluster/applyConfig', { baseUrl: `/k8s/clusters/${ escape(id) }/v1` });
    commit('clusterExternal/applyConfig', { baseUrl: `/v1/management.cattle.io.v3.clusters/${ escape(id) }` });

    await dispatch('cluster/loadSchemas');
    await dispatch('clusterExternal/loadSchemas');

    dispatch('cluster/subscribe');
    dispatch('clusterExternal/subscribe');

    const res = await allHash({
      apiGroups:  dispatch('cluster/findAll', { type: API_GROUP, opt: { url: 'apiGroups', watch: false } }),
      counts:     dispatch('cluster/findAll', { type: COUNT, opt: { url: 'counts' } }),
      namespaces: dispatch('cluster/findAll', { type: NAMESPACE, opt: { url: 'core.v1.namespaces' } })
    });

    commit('updateNamespaces', {
      selected: getters['prefs/get'](NAMESPACES),
      all:      res.namespaces
    });

    commit('clusterChanged', true);

    console.log('Done loading cluster.');
  },

  switchNamespaces({ commit }, val) {
    commit('prefs/set', { key: NAMESPACES, val });
    commit('updateNamespaces', { selected: val });
  },

  onLogout({ commit }) {
    commit('managementChanged', false);
    commit('management/removeAll');

    commit('cluster/removeAll');
    commit('rancher/removeAll');
  },

  nuxtServerInit(ctx, nuxt) {
    // Models in SSR server mode have no way to get to the route or router, so hack one in...
    Object.defineProperty(ctx.rootState, '$router', { value: nuxt.app.router });
    Object.defineProperty(ctx.rootState, '$route', { value: nuxt.route });
  },

  nuxtClientInit({ dispatch }) {
    dispatch('management/rehydrateSubscribe');
    dispatch('cluster/rehydrateSubscribe');
  }
};
